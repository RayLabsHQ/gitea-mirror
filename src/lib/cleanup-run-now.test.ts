/**
 * Run now for database maintenance and repository cleanup (#547), and the
 * repository cleanup no longer moving database maintenance's next run (#548).
 *
 * Runs against the real schema in an in-memory SQLite database that replaces
 * @/lib/db through mock.module, with the source host faked, so the file runs
 * in its own process.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_RUN = new Date("2026-11-20T00:00:00Z");
const NEXT_RUN = new Date("2026-11-27T00:00:00Z");

/** The fake source host: lists nothing and finds nothing, so a repository from it is gone. */
let listRepositories: () => Promise<any[]> = async () => [];
const provider = {
  connection: {},
  listRepositories: () => listRepositories(),
  listStarredRepositories: async () => [],
  getRepository: async () => null,
  isRepositoryStarred: async () => false,
};

if (isolated) {
  process.env.ENCRYPTION_SECRET ??= "cleanup-run-now-test-secret-0123456789";
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
    listSources: async () => [{ id: "src-1", name: "GitHub", provider: "github", enabled: true }],
  }));
}

const { runDatabaseCleanupNow, runAutomaticCleanup } = isolated
  ? await import("@/lib/cleanup-service")
  : ({} as Partial<typeof import("@/lib/cleanup-service")>);
const { triggerRepositoryCleanup, RepositoryCleanupBusyError } = isolated
  ? await import("@/lib/repository-cleanup-service")
  : ({} as Partial<typeof import("@/lib/repository-cleanup-service")>);

async function cleanupConfig(userId = "user-1") {
  const [row] = await db.select().from(schema.configs).where(eq(schema.configs.userId, userId));
  return row.cleanupConfig as any;
}

async function seedUser(userId: string, cleanup: Record<string, unknown>) {
  sqlite.run(`INSERT INTO users (id, email) VALUES ('${userId}', '${userId}@example.com')`);
  await db.insert(schema.configs).values({
    id: `config-${userId}`,
    userId,
    name: "Default",
    isActive: true,
    githubConfig: { owner: "octo" } as any,
    giteaConfig: { url: "https://gitea.example.com", defaultOwner: "mirror" } as any,
    scheduleConfig: { enabled: false } as any,
    cleanupConfig: cleanup as any,
  });
}

if (isolated) {
  describe("database maintenance Run now", () => {
    beforeEach(async () => {
      for (const table of ["events", "mirror_jobs", "repositories", "configs", "users"]) {
        sqlite.run(`DELETE FROM ${table}`);
      }
      const cleanup = { enabled: true, retentionDays: 7 * 86400, lastRun: LAST_RUN, nextRun: NEXT_RUN };
      await seedUser("user-1", cleanup);
      await seedUser("user-2", cleanup);

      const old = new Date(Date.now() - 10 * DAY_MS);
      const recent = new Date(Date.now() - 1 * DAY_MS);
      const event = (id: string, userId: string, createdAt: Date) => ({
        id,
        userId,
        channel: "repository",
        payload: {},
        createdAt,
      });
      await db.insert(schema.events).values([
        event("e-old-1", "user-1", old),
        event("e-old-2", "user-1", old),
        event("e-new", "user-1", recent),
        event("e-other", "user-2", old),
      ]);
      const job = (id: string, userId: string, timestamp: Date, inProgress = false) => ({
        id,
        userId,
        status: "mirrored" as const,
        message: "done",
        timestamp,
        inProgress,
      });
      await db.insert(schema.mirrorJobs).values([
        job("j-old", "user-1", old),
        job("j-running", "user-1", old, true),
        job("j-new", "user-1", recent),
        job("j-other", "user-2", old),
      ]);
    });

    test("removes this user's old entries, reports the counts and records the run", async () => {
      const before = Date.now();
      const result = await runDatabaseCleanupNow!("user-1");

      expect(result.eventsDeleted).toBe(2);
      expect(result.mirrorJobsDeleted).toBe(1);

      const events = (await db.select().from(schema.events)).map(row => row.id).sort();
      expect(events).toEqual(["e-new", "e-other"]);
      const jobs = (await db.select().from(schema.mirrorJobs)).map(row => row.id).sort();
      expect(jobs).toEqual(["j-new", "j-other", "j-running"]);

      const stored = await cleanupConfig();
      expect(new Date(stored.lastRun).getTime()).toBeGreaterThanOrEqual(before - 1000);
      // 7 day retention runs daily
      expect(new Date(stored.nextRun).getTime() - new Date(stored.lastRun).getTime()).toBe(DAY_MS);
      expect(new Date((await cleanupConfig("user-2")).nextRun)).toEqual(NEXT_RUN);
    });

    test("the hourly check leaves a user alone until the next run is due", async () => {
      const results = await runAutomaticCleanup!();
      expect(results).toEqual([]);
      expect(await db.select().from(schema.events)).toHaveLength(4);
    });
  });

  describe("repository cleanup Run now", () => {
    beforeEach(async () => {
      listRepositories = async () => [];
      for (const table of ["events", "mirror_jobs", "repositories", "configs", "users"]) {
        sqlite.run(`DELETE FROM ${table}`);
      }
      await seedUser("user-1", {
        enabled: true,
        retentionDays: 7 * 86400,
        deleteIfNotInGitHub: true,
        deleteFromGitea: false,
        orphanedRepoAction: "archive",
        dryRun: false,
        pauseBetweenDeletes: 0,
        lastRun: LAST_RUN,
        nextRun: NEXT_RUN,
      });
      await db.insert(schema.repositories).values({
        id: "repo-1",
        userId: "user-1",
        configId: "config-user-1",
        sourceId: "src-1",
        name: "gone",
        fullName: "octo/gone",
        normalizedFullName: "octo/gone",
        url: "https://github.com/octo/gone",
        cloneUrl: "https://github.com/octo/gone.git",
        owner: "octo",
        defaultBranch: "main",
        status: "mirrored",
      } as any);
    });

    test("archives a repository whose source is gone and leaves the maintenance times alone", async () => {
      const result = await triggerRepositoryCleanup!("user-1");

      expect(result).toMatchObject({
        orphanedCount: 1,
        processedCount: 1,
        errors: [],
        repositories: ["octo/gone"],
        dryRun: false,
        action: "archive",
      });
      const [repo] = await db.select().from(schema.repositories);
      expect(repo.status).toBe("archived");

      const stored = await cleanupConfig();
      expect(new Date(stored.lastRun)).toEqual(LAST_RUN);
      expect(new Date(stored.nextRun)).toEqual(NEXT_RUN);
    });

    test("a second click while a run is going is refused", async () => {
      let release!: () => void;
      let listed!: () => void;
      const listing = new Promise<void>(resolve => (listed = resolve));
      listRepositories = () => {
        listed();
        return new Promise(resolve => (release = () => resolve([])));
      };

      const first = triggerRepositoryCleanup!("user-1");
      await listing;
      await expect(triggerRepositoryCleanup!("user-1")).rejects.toBeInstanceOf(RepositoryCleanupBusyError!);
      release();
      expect((await first).orphanedCount).toBe(1);

      // Once it finished, Run now works again.
      listRepositories = async () => [];
      await expect(triggerRepositoryCleanup!("user-1")).resolves.toMatchObject({ orphanedCount: 0 });
    });
  });
}
