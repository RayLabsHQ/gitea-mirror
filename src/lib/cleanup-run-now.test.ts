/**
 * Run now for database maintenance and repository cleanup (#547), the
 * repository cleanup no longer moving database maintenance's next run (#548),
 * the cleanup notification (#554) and the wait before acting (#549).
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
// Whole seconds, a week either side of now: the next run must stay in the future.
const NOW_S = Math.floor(Date.now() / 1000) * 1000;
const LAST_RUN = new Date(NOW_S - 7 * DAY_MS);
const NEXT_RUN = new Date(NOW_S + 7 * DAY_MS);

/** The fake source host: lists nothing and finds nothing, so a repository from it is gone. */
let listRepositories: () => Promise<any[]> = async () => [];
const provider = {
  // A token, so cleanup takes the account listing (no token is the public only path, #589).
  connection: { token: "token" },
  listRepositories: () => listRepositories(),
  listStarredRepositories: async () => [],
  getRepository: async () => null,
  isRepositoryStarred: async () => false,
};

/** Notifications that reached the webhook provider. */
const sent: { title: string; message: string; type: string }[] = [];

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
  // Only the transport is faked: the config lookup, the switch and the text are real.
  mock.module("@/lib/providers/webhook", () => ({
    sendWebhookNotification: async (_config: unknown, event: any) => {
      sent.push(event);
    },
  }));
}

const { runDatabaseCleanupNow, runAutomaticCleanup } = isolated
  ? await import("@/lib/cleanup-service")
  : ({} as Partial<typeof import("@/lib/cleanup-service")>);
const { triggerRepositoryCleanup, RepositoryCleanupBusyError, runRepositoryCleanupForConfig } = isolated
  ? await import("@/lib/repository-cleanup-service")
  : ({} as Partial<typeof import("@/lib/repository-cleanup-service")>);

async function cleanupConfig(userId = "user-1") {
  const [row] = await db.select().from(schema.configs).where(eq(schema.configs.userId, userId));
  return row.cleanupConfig as any;
}

async function seedUser(userId: string, cleanup: Record<string, unknown>, notification?: Record<string, unknown>) {
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
    ...(notification ? { notificationConfig: notification as any } : {}),
  });
}

const NOTIFY_ON_CLEANUP = {
  enabled: true,
  provider: "webhook",
  notifyOnSyncError: true,
  notifyOnSyncSuccess: false,
  notifyOnNewRepo: false,
  notifyOnCleanup: true,
  webhook: { enabled: true, url: "https://hooks.example.com/gitea-mirror" },
};

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

  describe("repository cleanup notification (#554)", () => {
    const seed = async (cleanup: Record<string, unknown> = {}, notification: Record<string, unknown> = NOTIFY_ON_CLEANUP) => {
      listRepositories = async () => [];
      sent.length = 0;
      for (const table of ["events", "mirror_jobs", "repositories", "configs", "users"]) {
        sqlite.run(`DELETE FROM ${table}`);
      }
      await seedUser("user-1", {
        enabled: true,
        deleteIfNotInGitHub: true,
        deleteFromGitea: false,
        orphanedRepoAction: "archive",
        dryRun: false,
        pauseBetweenDeletes: 0,
        ...cleanup,
      }, notification);
      for (const name of ["gone", "also-gone"]) {
        await db.insert(schema.repositories).values({
          id: `repo-${name}`,
          userId: "user-1",
          configId: "config-user-1",
          sourceId: "src-1",
          name,
          fullName: `octo/${name}`,
          normalizedFullName: `octo/${name}`,
          url: `https://github.com/octo/${name}`,
          cloneUrl: `https://github.com/octo/${name}.git`,
          owner: "octo",
          defaultBranch: "main",
          status: "mirrored",
        } as any);
      }
    };

    test("one notification lists what the run archived, and the next run does not repeat it", async () => {
      await seed();

      await triggerRepositoryCleanup!("user-1");

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe("repo_cleanup");
      expect(sent[0].title).toBe("Repository Cleanup: 2 repositories archived");
      expect(sent[0].message).toContain("marked archived in gitea-mirror because the source is gone");
      expect(sent[0].message).toContain("- octo/gone");
      expect(sent[0].message).toContain("- octo/also-gone");

      // Both are archived now, so the next run leaves them out.
      const again = await triggerRepositoryCleanup!("user-1");
      expect(again.handled).toEqual([]);
      expect(sent).toHaveLength(1);
    });

    test("removed from gitea-mirror with the delete action", async () => {
      await seed({ orphanedRepoAction: "delete" });

      await triggerRepositoryCleanup!("user-1");

      expect(sent).toHaveLength(1);
      expect(sent[0].title).toBe("Repository Cleanup: 2 repositories deleted");
      expect(sent[0].message).toContain("removed from gitea-mirror because the source is gone");
      expect(await db.select().from(schema.repositories)).toHaveLength(0);
    });

    test("a dry run and the skip action send nothing", async () => {
      await seed({ dryRun: true });
      expect((await triggerRepositoryCleanup!("user-1")).orphanedCount).toBe(2);
      expect(sent).toHaveLength(0);

      await seed({ orphanedRepoAction: "skip" });
      expect((await triggerRepositoryCleanup!("user-1")).orphanedCount).toBe(2);
      expect(sent).toHaveLength(0);
    });

    test("nothing is sent with the switch off, or from a config saved before it existed", async () => {
      await seed({}, { ...NOTIFY_ON_CLEANUP, notifyOnCleanup: false });
      await triggerRepositoryCleanup!("user-1");
      expect(sent).toHaveLength(0);

      const { notifyOnCleanup: _dropped, ...older } = NOTIFY_ON_CLEANUP;
      await seed({}, older);
      await triggerRepositoryCleanup!("user-1");
      expect(sent).toHaveLength(0);
    });
  });

  describe("wait before acting (#549)", () => {
    const missingSince = async (id = "repo-gone") => {
      const [row] = await db.select().from(schema.repositories).where(eq(schema.repositories.id, id));
      return row?.sourceMissingSince ?? null;
    };
    const status = async (id = "repo-gone") => {
      const [row] = await db.select().from(schema.repositories).where(eq(schema.repositories.id, id));
      return row?.status;
    };
    /** Move the recorded time back, as if the source went missing days ago. */
    const backdate = (days: number, id = "repo-gone") => {
      const seconds = Math.floor((Date.now() - days * DAY_MS) / 1000);
      sqlite.run(`UPDATE repositories SET source_missing_since = ${seconds} WHERE id = '${id}'`);
    };
    const seed = async (cleanup: Record<string, unknown> = {}, notification: Record<string, unknown> = NOTIFY_ON_CLEANUP) => {
      listRepositories = async () => [];
      sent.length = 0;
      for (const table of ["events", "mirror_jobs", "repositories", "configs", "users"]) {
        sqlite.run(`DELETE FROM ${table}`);
      }
      await seedUser("user-1", {
        enabled: true,
        deleteIfNotInGitHub: true,
        deleteFromGitea: true,
        orphanedRepoAction: "archive",
        orphanedRepoGraceDays: 7,
        dryRun: true,
        pauseBetweenDeletes: 0,
        ...cleanup,
      }, notification);
      await db.insert(schema.repositories).values({
        id: "repo-gone",
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
    };

    test("the first run records when the source went missing and waits, with one heads-up", async () => {
      // A real action, so the heads-up names it; dry run is checked separately.
      await seed({ dryRun: false, deleteFromGitea: false });
      const before = Date.now();

      const result = await triggerRepositoryCleanup!("user-1");

      expect(result.orphanedCount).toBe(1);
      expect(result.handled).toEqual([]);
      expect(result.processedCount).toBe(0);
      expect(result.waiting).toHaveLength(1);
      expect(result.waiting[0].fullName).toBe("octo/gone");
      const since = await missingSince();
      expect(since).toBeInstanceOf(Date);
      expect(since!.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(new Date(result.waiting[0].actOn).getTime()).toBe(since!.getTime() + 7 * DAY_MS);
      expect(await status()).toBe("mirrored");

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe("repo_cleanup");
      expect(sent[0].title).toBe("Repository Cleanup: source gone for 1 repository");
      expect(sent[0].message).toContain(
        `If it is still gone on ${result.waiting[0].actOn.slice(0, 10)} (7 days from now), the repository will be marked archived in gitea-mirror.`
      );
      expect(sent[0].message).toContain("The copies on the destination will not be changed.");
      expect(sent[0].message).toContain("- octo/gone");

      // The next run keeps the first time and does not repeat the heads-up.
      const again = await triggerRepositoryCleanup!("user-1");
      expect(again.waiting.map((entry) => entry.actOn)).toEqual(result.waiting.map((entry) => entry.actOn));
      expect((await missingSince())!.getTime()).toBe(since!.getTime());
      expect(sent).toHaveLength(1);
    });

    test("once the source has been gone long enough the action runs and is reported", async () => {
      await seed({ dryRun: false, deleteFromGitea: false });
      await triggerRepositoryCleanup!("user-1");
      backdate(8);
      sent.length = 0;

      const result = await triggerRepositoryCleanup!("user-1");

      expect(result.handled).toEqual(["octo/gone"]);
      expect(result.waiting).toEqual([]);
      expect(await status()).toBe("archived");
      expect(sent).toHaveLength(1);
      expect(sent[0].title).toBe("Repository Cleanup: 1 repository archived");
    });

    test("a source that comes back during the wait resets it", async () => {
      await seed({ dryRun: false });
      await triggerRepositoryCleanup!("user-1");
      backdate(6);

      listRepositories = async () => [{ fullName: "octo/gone", name: "gone", owner: "octo" }];
      const back = await triggerRepositoryCleanup!("user-1");
      expect(back.orphanedCount).toBe(0);
      expect(await missingSince()).toBeNull();

      // Gone again: the wait starts over instead of acting on the old time.
      listRepositories = async () => [];
      sent.length = 0;
      const gone = await triggerRepositoryCleanup!("user-1");
      expect(gone.handled).toEqual([]);
      expect(gone.waiting).toHaveLength(1);
      expect(await status()).toBe("mirrored");
      expect(sent).toHaveLength(1);
      expect(sent[0].title).toBe("Repository Cleanup: source gone for 1 repository");
    });

    test("a failed lookup neither starts nor resets the wait", async () => {
      await seed({ dryRun: false });
      await triggerRepositoryCleanup!("user-1");
      backdate(6);
      const since = await missingSince();

      listRepositories = async () => {
        throw Object.assign(new Error("Bad gateway"), { status: 502 });
      };
      const result = await triggerRepositoryCleanup!("user-1");
      expect(result.orphanedCount).toBe(0);
      expect((await missingSince())!.getTime()).toBe(since!.getTime());
    });

    test("no wait acts on the first run, without a heads-up", async () => {
      await seed({ dryRun: false, orphanedRepoGraceDays: 0, deleteFromGitea: false });

      const result = await triggerRepositoryCleanup!("user-1");

      expect(result.handled).toEqual(["octo/gone"]);
      expect(result.waiting).toEqual([]);
      expect(sent.map((event) => event.title)).toEqual(["Repository Cleanup: 1 repository archived"]);
    });

    test("a dry run records the time and lists the date, but sends nothing", async () => {
      await seed({ dryRun: true });

      const result = await triggerRepositoryCleanup!("user-1");

      expect(result.waiting).toHaveLength(1);
      expect(await missingSince()).toBeInstanceOf(Date);
      expect(sent).toHaveLength(0);

      // Past the wait, a dry run still changes nothing.
      backdate(8);
      const later = await triggerRepositoryCleanup!("user-1");
      expect(later.waiting).toEqual([]);
      expect(later.handled).toEqual([]);
      expect(await status()).toBe("mirrored");
    });

    test("the skip action and protected repositories get no heads-up", async () => {
      await seed({ dryRun: false, orphanedRepoAction: "skip" });
      await triggerRepositoryCleanup!("user-1");
      expect(sent).toHaveLength(0);

      await seed({ dryRun: false, protectedRepos: ["octo/gone"] });
      const result = await triggerRepositoryCleanup!("user-1");
      expect(result.waiting).toEqual([]);
      expect(await missingSince()).toBeNull();
      expect(sent).toHaveLength(0);
    });

    test("the scheduled sync's cleanup waits too", async () => {
      await seed({ dryRun: false, deleteFromGitea: false });
      const [config] = await db.select().from(schema.configs).where(eq(schema.configs.userId, "user-1"));

      const result = await runRepositoryCleanupForConfig!(config);

      expect(result.waiting).toHaveLength(1);
      expect(await status()).toBe("mirrored");
      expect(sent.map((event) => event.title)).toEqual(["Repository Cleanup: source gone for 1 repository"]);

      backdate(8);
      const later = await runRepositoryCleanupForConfig!(config);
      expect(later.handled).toEqual(["octo/gone"]);
      expect(await status()).toBe("archived");
    });

    test("the scheduled sync's cleanup leaves protected repositories alone", async () => {
      // It used to call the action for every orphan directly, skipping this list.
      await seed({ dryRun: false, orphanedRepoGraceDays: 0, protectedRepos: ["octo/gone"] });
      const [config] = await db.select().from(schema.configs).where(eq(schema.configs.userId, "user-1"));

      const result = await runRepositoryCleanupForConfig!(config);

      expect(result.orphanedCount).toBe(1);
      expect(result.handled).toEqual([]);
      expect(await status()).toBe("mirrored");
    });
  });
}
