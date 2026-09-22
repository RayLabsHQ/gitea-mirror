/**
 * Route tests for POST /api/job/sync-org: the manual re-sync of one
 * organization (#429). The route re-discovers the organization's
 * repositories, mirrors the ones that were never mirrored and refreshes the
 * ones that were, while the organization sits at "mirroring".
 *
 * Runs against the real schema in an in-memory SQLite database. The route
 * imports @/lib/db, which is replaced with that database through
 * mock.module; bun's mock.module is process-wide and leaks into other test
 * files, so this file registers nothing in the shared process and re-runs
 * itself in an isolated child (same harness as
 * ../organizations/[id]/status.test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const CHILD_FLAG = "GM_SYNC_ORG_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("organization sync route - isolated child suite", () => {
    const res = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, [CHILD_FLAG]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) {
      console.error(res.stdout.toString());
      console.error(res.stderr.toString());
    }
    expect(res.exitCode).toBe(0);
  }, 120_000);
}

const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite });

/**
 * Apply every migration in drizzle/ in journal order. The shared test setup
 * stubs drizzle's migrator, so the SQL is run here the way the migrator
 * would: one file per journal entry, statements split on its breakpoint.
 */
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

/** Repositories the mirror entry point was called for, in call order. */
const mirrorCalls: string[] = [];
/** Repositories the sync entry point was called for, in call order. */
const syncCalls: string[] = [];
/** Repository names whose sync must throw, and the ones that report a skip. */
const syncFailures = new Set<string>();
const syncSkips = new Set<string>();
/**
 * The organization-level job records the run writes. The shared test setup
 * stubs @/lib/helpers, so the mirror_jobs rows (and the realtime events
 * createMirrorJob publishes from them) cannot be read back from the
 * database; this spy stands in for both.
 */
const jobCalls: {
  status: string;
  jobType?: string;
  organizationId?: string;
  message: string;
  details?: string;
}[] = [];
/** Rows the (mocked) re-discovery pass inserts before the run plans its work. */
let discoveryInserts: string[] = [];
let discoveryThrows = false;

const sourceRows = [
  {
    id: "source-github",
    userId: "user-1",
    name: "GitHub",
    provider: "github",
    url: "https://github.com",
    username: "octocat",
    token: "source-token",
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
];

if (isChild) {
  applyMigrations();
  // The seeds below only cover the tables the route touches.
  sqlite.run("PRAGMA foreign_keys = OFF");

  mock.module("@/lib/auth-guards", () => ({
    requireAuthenticatedUserId: mock(async () => ({ userId: "user-1" })),
  }));

  mock.module("@/lib/db", () => ({ ...schema, db }));

  mock.module("@/lib/helpers", () => ({
    createMirrorJob: mock(async (job: (typeof jobCalls)[number]) => {
      jobCalls.push(job);
      return "job-id";
    }),
    createEvent: mock(async () => {}),
    updateMirrorJobProgress: mock(async () => {}),
    touchMirrorJobCheckpoint: mock(async () => {}),
  }));

  mock.module("@/lib/sources", () => ({
    listSources: mock(async () => sourceRows),
    findSourceForOrganization: (org: { sourceId?: string | null }) =>
      org.sourceId ? sourceRows.find((source) => source.id === org.sourceId) ?? null : null,
    findSourceForRepository: () => sourceRows[0],
    decryptSourceToken: (token: string | null | undefined) => token ?? "",
    resolveGitHubApiBaseUrl: () => undefined,
    ensureSourcesFromConfig: mock(async () => {}),
  }));

  mock.module("@/lib/github", () => ({
    createGitHubClient: mock(() => ({ authenticated: true })),
    createPublicGitHubClient: mock(() => ({ anonymous: true })),
  }));

  mock.module("@/lib/gitea", () => ({
    getGiteaRepoOwnerAsync: mock(async () => "acme"),
  }));

  mock.module("@/lib/mirror-dispatch", () => ({
    mirrorRepositoryToDestination: mock(async ({ repository }: { repository: { name: string } }) => {
      mirrorCalls.push(repository.name);
      if (syncFailures.has(repository.name)) {
        throw new Error(`mirror of ${repository.name} failed`);
      }
      return {};
    }),
    syncRepositoryOnDestination: mock(async ({ repository }: { repository: { name: string } }) => {
      syncCalls.push(repository.name);
      if (syncFailures.has(repository.name)) {
        throw new Error(`sync of ${repository.name} failed`);
      }
      if (syncSkips.has(repository.name)) {
        return { skipped: true, reason: "already-in-progress" };
      }
      return {};
    }),
  }));

  mock.module("@/lib/organization-discovery", () => ({
    rediscoverRepositoriesForOrganization: mock(async () => {
      if (discoveryThrows) throw new Error("source unreachable");
      for (const name of discoveryInserts) {
        seedRepo({ id: name, organization: "acme", status: "imported" });
      }
      return {
        ran: true,
        listed: discoveryInserts.length,
        imported: discoveryInserts.length,
        alreadyTracked: 0,
      };
    }),
  }));

  // The real helper retries with exponential backoff and drops the items
  // that never succeed from its results; this runs the same contract without
  // the waiting.
  mock.module("@/lib/utils/concurrency", () => ({
    processWithResilience: mock(async (items: unknown[], worker: (item: unknown) => Promise<unknown>) => {
      const results: unknown[] = [];
      for (const item of items) {
        try {
          results.push(await worker(item));
        } catch {
          // Dropped, exactly as Promise.allSettled does in the real helper.
        }
      }
      return results;
    }),
  }));
}

const { POST } = isChild ? await import("./sync-org") : { POST: undefined as any };

function post(body: Record<string, unknown>) {
  return POST({
    request: new Request("http://localhost/api/job/sync-org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: { session: { userId: "user-1" } },
  } as any);
}

type RepoSeed = {
  id: string;
  userId?: string;
  organization: string | null;
  status: string;
  isForked?: boolean;
  sourceId?: string | null;
};

function seedRepo({
  id,
  userId = "user-1",
  organization,
  status,
  isForked = false,
  sourceId = "source-github",
}: RepoSeed) {
  const owner = organization ?? "octocat";
  sqlite.run(
    `INSERT INTO repositories (id, user_id, config_id, name, full_name, normalized_full_name, url, clone_url, owner, organization, default_branch, status, is_fork, source_id)
     VALUES (?, ?, 'config-1', ?, ?, ?, ?, ?, ?, ?, 'main', ?, ?, ?)`,
    [
      id,
      userId,
      id,
      `${owner}/${id}`,
      `${owner}/${id}`.toLowerCase(),
      `https://github.com/${owner}/${id}`,
      `https://github.com/${owner}/${id}.git`,
      owner,
      organization,
      status,
      isForked ? 1 : 0,
      sourceId,
    ]
  );
}

function seedConfig(): void {
  sqlite.run(
    `INSERT INTO configs (id, user_id, name, github_config, gitea_config, schedule_config, cleanup_config)
     VALUES ('config-1', 'user-1', 'default', ?, ?, '{}', '{}')`,
    [
      JSON.stringify({ owner: "octocat", mirrorStrategy: "preserve", skipForks: false }),
      JSON.stringify({ url: "https://gitea.example.com", token: "gitea-token", defaultOwner: "octocat" }),
    ]
  );
}

function seedOrg({
  id,
  userId = "user-1",
  name,
  status,
  mirrorOverrides = null,
}: {
  id: string;
  userId?: string;
  name: string;
  status: string;
  mirrorOverrides?: string | null;
}) {
  sqlite.run(
    `INSERT INTO organizations (id, user_id, config_id, name, normalized_name, avatar_url, status, source_id, mirror_overrides)
     VALUES (?, ?, 'config-1', ?, ?, '', ?, 'source-github', ?)`,
    [id, userId, name, name.toLowerCase(), status, mirrorOverrides]
  );
}

function orgRow(id: string): { status: string; last_mirrored: number | null; error_message: string | null } {
  return sqlite
    .query("SELECT status, last_mirrored, error_message FROM organizations WHERE id = ?")
    .get(id) as any;
}

/** Wait until the background run has settled the organization's status. */
async function waitForSettled(id: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = orgRow(id)?.status;
    if (status && status !== "mirroring") return status;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for organization ${id} to settle (status ${status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  if (!isChild) return;
  sqlite.run("DELETE FROM repositories");
  sqlite.run("DELETE FROM organizations");
  sqlite.run("DELETE FROM configs");
  mirrorCalls.length = 0;
  syncCalls.length = 0;
  jobCalls.length = 0;
  syncFailures.clear();
  syncSkips.clear();
  discoveryInserts = [];
  discoveryThrows = false;

  seedConfig();
  seedOrg({ id: "org-acme", name: "acme", status: "mirrored" });
  seedOrg({ id: "org-theirs", userId: "user-2", name: "theirs", status: "mirrored" });

  seedRepo({ id: "acme-imported", organization: "acme", status: "imported" });
  seedRepo({ id: "acme-mirrored", organization: "acme", status: "mirrored" });
  seedRepo({ id: "acme-synced", organization: "acme", status: "synced" });
  seedRepo({ id: "acme-failed", organization: "acme", status: "failed" });
  // Owned by another run, on the way out, or opted out: left alone.
  seedRepo({ id: "acme-mirroring", organization: "acme", status: "mirroring" });
  seedRepo({ id: "acme-syncing", organization: "acme", status: "syncing" });
  seedRepo({ id: "acme-deleting", organization: "acme", status: "deleting" });
  seedRepo({ id: "acme-ignored", organization: "acme", status: "ignored" });
  // Another organization and a personal repository: not this organization's.
  seedRepo({ id: "beta-mirrored", organization: "beta", status: "mirrored" });
  seedRepo({ id: "personal-mirrored", organization: null, status: "mirrored" });
});

describe.skipIf(!isChild)("POST /api/job/sync-org", () => {
  test("rejects a request without an orgId", async () => {
    const response = await post({});
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("orgId is required.");
  });

  test("answers 404 for another user's organization", async () => {
    const response = await post({ orgId: "org-theirs" });
    expect(response.status).toBe(404);
    expect(orgRow("org-theirs").status).toBe("mirrored");
    expect(mirrorCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test("refuses an ignored organization and touches nothing", async () => {
    sqlite.run("UPDATE organizations SET status = 'ignored' WHERE id = 'org-acme'");

    const response = await post({ orgId: "org-acme" });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error).toContain("ignored");
    expect(orgRow("org-acme").status).toBe("ignored");
    expect(mirrorCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test("refuses an organization that is already being processed", async () => {
    sqlite.run("UPDATE organizations SET status = 'mirroring' WHERE id = 'org-acme'");

    const response = await post({ orgId: "org-acme" });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error).toContain("already being processed");
    expect(mirrorCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test("answers with the queued counts and reports the organization as mirroring", async () => {
    const response = await post({ orgId: "org-acme" });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe("Sync job started.");
    expect(data.organization.id).toBe("org-acme");
    expect(data.organization.status).toBe("mirroring");
    // One imported, three already on the destination, four left alone.
    expect(data.queued).toEqual({ mirror: 1, sync: 3, skipped: 4 });

    await waitForSettled("org-acme");
  });

  test("mirrors what was never mirrored, syncs the rest and skips the others", async () => {
    await post({ orgId: "org-acme" });
    expect(await waitForSettled("org-acme")).toBe("mirrored");

    expect(mirrorCalls).toEqual(["acme-imported"]);
    expect(syncCalls.sort()).toEqual(["acme-failed", "acme-mirrored", "acme-synced"]);

    const settled = orgRow("org-acme");
    expect(settled.last_mirrored).not.toBeNull();
    expect(settled.error_message).toBeNull();
  });

  test("picks up the repositories the re-discovery pass imported", async () => {
    discoveryInserts = ["acme-brand-new"];

    const response = await post({ orgId: "org-acme" });
    const data = await response.json();
    // The answer is a snapshot of the rows as they stood: the new row is
    // discovered by the run itself and mirrored on top of the promise.
    expect(data.queued.mirror).toBe(1);

    expect(await waitForSettled("org-acme")).toBe("mirrored");
    expect(mirrorCalls.sort()).toEqual(["acme-brand-new", "acme-imported"]);
  });

  test("keeps going when the re-discovery pass fails", async () => {
    discoveryThrows = true;

    await post({ orgId: "org-acme" });
    expect(await waitForSettled("org-acme")).toBe("mirrored");

    expect(mirrorCalls).toEqual(["acme-imported"]);
    expect(syncCalls.length).toBe(3);

    const done = jobCalls.find((job) => job.status === "mirrored");
    expect(done?.details).toContain("Re-discovery failed");
  });

  test("holds forks back from the mirror set when the organization skips forks", async () => {
    sqlite.run("DELETE FROM repositories WHERE id = 'acme-imported'");
    seedRepo({ id: "acme-fork", organization: "acme", status: "imported", isForked: true });
    sqlite.run(
      "UPDATE organizations SET mirror_overrides = ? WHERE id = 'org-acme'",
      [JSON.stringify({ skipForks: true })]
    );

    const response = await post({ orgId: "org-acme" });
    const data = await response.json();
    expect(data.queued).toEqual({ mirror: 0, sync: 3, skipped: 5 });

    expect(await waitForSettled("org-acme")).toBe("mirrored");
    expect(mirrorCalls).toEqual([]);
  });

  test("a repository another run owns counts as in progress, not as a failure", async () => {
    syncSkips.add("acme-mirrored");

    await post({ orgId: "org-acme" });
    expect(await waitForSettled("org-acme")).toBe("mirrored");

    const done = jobCalls.find((job) => job.status === "mirrored");
    expect(done?.details).toContain("1 already in progress");
    expect(done?.details).toContain("0 failed");
  });

  test("marks the organization failed when a repository does not make it", async () => {
    syncFailures.add("acme-failed");

    await post({ orgId: "org-acme" });
    expect(await waitForSettled("org-acme")).toBe("failed");

    const settled = orgRow("org-acme");
    expect(settled.error_message).toContain("1 repository failed");

    const failedJob = jobCalls.find((job) => job.status === "failed");
    expect(failedJob?.message).toContain("Failed to sync organization");
  });

  test("records the start and the end of the run as organization jobs", async () => {
    await post({ orgId: "org-acme" });
    expect(await waitForSettled("org-acme")).toBe("mirrored");

    // Both carry the organization, so the realtime event createMirrorJob
    // publishes reaches the card and the UI follows the run.
    expect(jobCalls.map((job) => job.status)).toEqual(["mirroring", "mirrored"]);
    expect(jobCalls.every((job) => job.jobType === "sync")).toBe(true);
    expect(jobCalls.every((job) => job.organizationId === "org-acme")).toBe(true);
  });
});
