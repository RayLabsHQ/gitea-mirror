/**
 * GET /api/dashboard: lastSync counts manual syncs, not only scheduler runs.
 *
 * The route imports @/lib/db and @/lib/auth-guards, which are replaced here
 * through mock.module; bun's mock.module is process-wide and leaks into other
 * test files, so this file registers nothing in the shared process and
 * re-runs itself in an isolated child (same harness as
 * ../job/sync-org.test.ts).
 */
import { expect, mock, test } from "bun:test";
import { repositories, organizations, mirrorJobs, configs } from "@/lib/db/schema";

const CHILD_FLAG = "GM_DASHBOARD_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("dashboard route - isolated child suite", () => {
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

if (isChild) {
  const mirroredAt = new Date("2026-09-28T12:00:00Z");
  const repo = { id: "repo-1", userId: "user-1", name: "example", status: "synced", lastMirrored: mirroredAt };
  const activity = { id: "job-1", userId: "user-1", status: "synced" };
  const results = [
    [repo], [], [activity], [{ scheduleConfig: { lastRun: null } }],
    [{ value: 1 }], [{ value: 0 }], [{ value: 1 }], [{ lastMirrored: mirroredAt }],
  ];
  let queryIndex = 0;

  mock.module("@/lib/db", () => ({
    db: {
      select: () => {
        const rows = results[queryIndex++];
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: async () => rows,
          then: (resolve: (value: unknown) => void) => resolve(rows),
        };
        return query;
      },
    },
    repositories, organizations, mirrorJobs, configs,
  }));

  mock.module("@/lib/auth-guards", () => ({
    requireAuthenticatedUserId: async () => ({ userId: "user-1" }),
  }));

  const { GET } = await import("./index");

  test("Dashboard includes manual syncs even when the scheduler has never run", async () => {
    queryIndex = 0;
    const response = await GET({ request: new Request("http://localhost/api/dashboard"), locals: {} } as any);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      repoCount: 1,
      orgCount: 0,
      mirroredCount: 1,
      repositories: [{ ...repo, lastMirrored: mirroredAt.toISOString() }],
      activities: [activity],
      lastSync: mirroredAt.toISOString(),
    });
  });
}
