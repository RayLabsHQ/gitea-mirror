/**
 * Repository cleanup on a public only source (#589). A source with no token
 * has no account, so cleanup must not ask for the account's repositories
 * (that built /users//orgs on Gitea and failed on every run). It lists the
 * organizations added to the source and checks every other repository on
 * its own.
 *
 * Runs against the real schema in an in-memory SQLite database that replaces
 * @/lib/db through mock.module, with the source host faked, so the file runs
 * in its own process.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { runsIsolated } from "@/tests/isolated";

const isolated = runsIsolated(import.meta.path);

const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite });

function applyMigrations(): void {
  const folder = join(process.cwd(), "drizzle");
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    const sql = readFileSync(join(folder, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.run(statement);
    }
  }
}

const listedOrganizations: string[] = [];
const checkedRepositories: string[] = [];
let organizationListing: (name: string) => Promise<any[]> = async () => [];
let stillThere = new Set<string>();

const gitRepo = (fullName: string) => ({ fullName, name: fullName.split("/")[1], owner: fullName.split("/")[0] });

/** A Gitea source with neither username nor token. */
const provider = {
  connection: { token: "", username: "", url: "https://git.example.org", provider: "gitea" },
  listRepositories: async () => {
    throw new Error("listRepositories must not run for a public only source");
  },
  listStarredRepositories: async () => {
    throw new Error("listStarredRepositories must not run for a public only source");
  },
  listOrganizationRepositories: async (name: string) => {
    listedOrganizations.push(name);
    return organizationListing(name);
  },
  getRepository: async (owner: string, name: string) => {
    checkedRepositories.push(`${owner}/${name}`);
    return stillThere.has(`${owner}/${name}`) ? gitRepo(`${owner}/${name}`) : null;
  },
  isRepositoryStarred: async () => {
    throw new Error("isRepositoryStarred must not run for a public only source");
  },
};

if (isolated) {
  process.env.ENCRYPTION_SECRET ??= "cleanup-public-only-test-secret-012345";
  applyMigrations();
  // Copy the real exports before mocking: mock.module patches the namespace.
  const realProviders = { ...(await import("@/lib/source-providers")) };
  const realSources = { ...(await import("@/lib/sources")) };
  mock.module("@/lib/db", () => ({ ...schema, db }));
  mock.module("@/lib/source-providers", () => ({
    ...realProviders,
    createSourceProviderFromSource: () => provider,
    isRepositoryFromConfiguredSource: () => true,
  }));
  mock.module("@/lib/sources", () => ({
    ...realSources,
    listSources: async () => [
      { id: "src-pub", name: "Gitea / Forgejo", provider: "gitea", url: "https://git.example.org", username: "", token: null, enabled: true },
    ],
  }));
}

const { identifyOrphanedRepositories } = isolated
  ? await import("@/lib/repository-cleanup-service")
  : ({} as Partial<typeof import("@/lib/repository-cleanup-service")>);

const CONFIG = {
  id: "config-1",
  userId: "user-1",
  githubConfig: { includeStarred: true },
  cleanupConfig: { enabled: true, deleteIfNotInGitHub: true, orphanedRepoAction: "archive" },
};

function repoRow(fullName: string, extra: Record<string, unknown> = {}) {
  const [owner, name] = fullName.split("/");
  return {
    id: `repo-${fullName.replace("/", "-")}`,
    userId: "user-1",
    configId: "config-1",
    sourceId: "src-pub",
    sourceProvider: "gitea",
    sourceUrl: "https://git.example.org",
    name,
    fullName,
    normalizedFullName: fullName.toLowerCase(),
    url: `https://git.example.org/${fullName}`,
    cloneUrl: `https://git.example.org/${fullName}.git`,
    owner,
    defaultBranch: "main",
    status: "mirrored",
    ...extra,
  } as any;
}

if (isolated) {
  describe("repository cleanup on a public only source (#589)", () => {
    beforeEach(async () => {
      for (const table of ["repositories", "organizations", "configs", "users"]) {
        sqlite.run(`DELETE FROM ${table}`);
      }
      listedOrganizations.length = 0;
      checkedRepositories.length = 0;
      organizationListing = async (name) => (name === "acme" ? [gitRepo("acme/kept")] : []);
      stillThere = new Set(["someone/single", "other-org/tool"]);

      sqlite.run(`INSERT INTO users (id, email) VALUES ('user-1', 'user-1@example.com')`);
      await db.insert(schema.configs).values({
        id: "config-1",
        userId: "user-1",
        name: "Default",
        isActive: true,
        githubConfig: CONFIG.githubConfig as any,
        giteaConfig: { url: "https://gitea.example.com", defaultOwner: "mirror" } as any,
        scheduleConfig: { enabled: false } as any,
        cleanupConfig: CONFIG.cleanupConfig as any,
      });
      await db.insert(schema.organizations).values([
        // Added to the public only source, and holds tracked repositories.
        { id: "org-acme", userId: "user-1", configId: "config-1", sourceId: "src-pub", name: "acme", normalizedName: "acme", avatarUrl: "" },
        // Added to the source, but nothing of it is tracked: not worth a listing.
        { id: "org-empty", userId: "user-1", configId: "config-1", sourceId: "src-pub", name: "empty", normalizedName: "empty", avatarUrl: "" },
      ] as any);
      await db.insert(schema.repositories).values([
        repoRow("acme/kept", { organization: "acme" }),
        repoRow("acme/gone", { organization: "acme" }),
        // Added by URL: no organization row behind it.
        repoRow("someone/single"),
        repoRow("other-org/tool", { organization: "other-org" }),
        // A star cannot be checked without an account.
        repoRow("starred/thing", { isStarred: true }),
      ]);
    });

    test("lists the added organization, checks the rest one by one and finds the deleted repository", async () => {
      const orphaned = await identifyOrphanedRepositories!(CONFIG);

      expect(orphaned.map((repo: any) => repo.fullName)).toEqual(["acme/gone"]);
      expect(listedOrganizations).toEqual(["acme"]);
      expect(checkedRepositories.sort()).toEqual(["acme/gone", "other-org/tool", "someone/single"]);
    });

    test("a failed organization listing falls back to checking that organization's repositories", async () => {
      organizationListing = async () => {
        throw new Error("503 Service Unavailable");
      };
      stillThere.add("acme/kept");

      const orphaned = await identifyOrphanedRepositories!(CONFIG);

      expect(orphaned.map((repo: any) => repo.fullName)).toEqual(["acme/gone"]);
      expect(checkedRepositories.sort()).toEqual(["acme/gone", "acme/kept", "other-org/tool", "someone/single"]);
    });
  });
}
