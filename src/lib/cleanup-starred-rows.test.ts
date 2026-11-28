/**
 * Repository cleanup and rows flagged starred (#600). The flag means the row
 * came in through the star list, and it stays after an unstar. With starred
 * import off, cleanup used to skip those rows outright, so a deleted source
 * behind one was never found. Now it reads the star list for them and checks
 * the rest by a plain lookup; only with starred import on does an unstar
 * count as gone.
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

const gitRepo = (fullName: string, extra: Record<string, unknown> = {}) => ({
  fullName,
  name: fullName.split("/")[1],
  owner: fullName.split("/")[0],
  ...extra,
});

/** What the fake source host was asked. */
const calls = {
  starListings: [] as unknown[],
  lookups: [] as string[],
  starChecks: [] as string[],
};
/** Repositories that exist on the source. */
let existing = new Set<string>();
/** Repositories the account has starred. */
let starred = new Set<string>();

const provider = {
  connection: { token: "token", username: "me", url: "https://github.com", provider: "github" },
  listRepositories: async () => [gitRepo("me/owned")],
  listStarredRepositories: async (config: any) => {
    calls.starListings.push(config?.githubConfig?.starredLists);
    return [...starred].map((fullName) => gitRepo(fullName, { isStarred: true }));
  },
  getRepository: async (owner: string, name: string) => {
    calls.lookups.push(`${owner}/${name}`);
    return existing.has(`${owner}/${name}`) ? gitRepo(`${owner}/${name}`) : null;
  },
  isRepositoryStarred: async (owner: string, name: string) => {
    calls.starChecks.push(`${owner}/${name}`);
    return starred.has(`${owner}/${name}`);
  },
};

if (isolated) {
  process.env.ENCRYPTION_SECRET ??= "cleanup-starred-rows-test-secret-0123456";
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
      { id: "src-gh", name: "GitHub", provider: "github", url: "https://github.com", username: "me", token: "token", enabled: true },
    ],
  }));
}

const { identifyOrphanedRepositories } = isolated
  ? await import("@/lib/repository-cleanup-service")
  : ({} as Partial<typeof import("@/lib/repository-cleanup-service")>);

function configWith(githubConfig: Record<string, unknown>) {
  return {
    id: "config-1",
    userId: "user-1",
    githubConfig,
    cleanupConfig: { enabled: true, deleteIfNotInGitHub: true, orphanedRepoAction: "archive" },
  };
}

function repoRow(fullName: string, extra: Record<string, unknown> = {}) {
  const [owner, name] = fullName.split("/");
  return {
    id: `repo-${fullName.replace("/", "-")}`,
    userId: "user-1",
    configId: "config-1",
    sourceId: "src-gh",
    sourceProvider: "github",
    sourceUrl: "https://github.com",
    name,
    fullName,
    normalizedFullName: fullName.toLowerCase(),
    url: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    owner,
    defaultBranch: "main",
    status: "mirrored",
    ...extra,
  } as any;
}

async function seed(rows: any[]) {
  for (const table of ["repositories", "organizations", "configs", "users"]) {
    sqlite.run(`DELETE FROM ${table}`);
  }
  sqlite.run(`INSERT INTO users (id, email) VALUES ('user-1', 'user-1@example.com')`);
  await db.insert(schema.configs).values({
    id: "config-1",
    userId: "user-1",
    name: "Default",
    isActive: true,
    githubConfig: {} as any,
    giteaConfig: { url: "https://gitea.example.com", defaultOwner: "mirror" } as any,
    scheduleConfig: { enabled: false } as any,
    cleanupConfig: { enabled: true } as any,
  });
  await db.insert(schema.repositories).values(rows);
}

if (isolated) {
  describe("repository cleanup and rows flagged starred (#600)", () => {
    beforeEach(async () => {
      calls.starListings.length = 0;
      calls.lookups.length = 0;
      calls.starChecks.length = 0;
      existing = new Set(["me/owned", "them/still-starred", "them/unstarred"]);
      starred = new Set(["them/still-starred"]);
      await seed([
        repoRow("me/owned"),
        repoRow("them/still-starred", { isStarred: true }),
        // Starred once, unstarred since, still on the source.
        repoRow("them/unstarred", { isStarred: true }),
        // Starred once, then deleted on the source.
        repoRow("them/deleted", { isStarred: true }),
      ]);
    });

    test("with starred import off, finds the deleted source and keeps the unstarred one", async () => {
      const orphaned = await identifyOrphanedRepositories!(
        configWith({ includeStarred: false, starredLists: ["old list"] })
      );

      expect(orphaned.map((repo: any) => repo.fullName)).toEqual(["them/deleted"]);
      // The star list is read once, without the saved list filter.
      expect(calls.starListings).toEqual([[]]);
      // Only rows missing from both listings are looked up, by existence.
      expect(calls.lookups.sort()).toEqual(["them/deleted", "them/unstarred"]);
      expect(calls.starChecks).toEqual([]);
    });

    test("with starred import on, an unstar still counts as gone", async () => {
      const orphaned = await identifyOrphanedRepositories!(configWith({ includeStarred: true }));

      expect(orphaned.map((repo: any) => repo.fullName).sort()).toEqual(["them/deleted", "them/unstarred"]);
      expect(calls.starChecks.sort()).toEqual(["them/deleted", "them/unstarred"]);
      expect(calls.lookups).toEqual([]);
    });

    test("with starred import off and no starred rows, the star list is not read", async () => {
      await seed([repoRow("me/owned")]);

      const orphaned = await identifyOrphanedRepositories!(configWith({ includeStarred: false }));

      expect(orphaned).toEqual([]);
      expect(calls.starListings).toEqual([]);
    });
  });
}
