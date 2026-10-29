/**
 * GET /api/activities: the feed must accept every status a mirror job can hold.
 *
 * "warning" is an activity-only status (see mirrorJobSchema) written when all
 * releases were filtered out of a repository. repoStatusEnum does not contain
 * it, and parsing with it turned the whole feed into a 500.
 *
 * mock.module is process-wide in bun, so this file re-runs itself in an
 * isolated child (same harness as ../dashboard/index.test.ts).
 */
import { expect, mock, test } from "bun:test";
import { mirrorJobs } from "@/lib/db/schema";

const CHILD_FLAG = "GM_ACTIVITIES_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("activities route - isolated child suite", () => {
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
  // Shaped like what the sync writes when the release filters empty a
  // destination (gitea.ts), typed as table rows so they track the schema.
  const rows: Array<typeof mirrorJobs.$inferSelect> = [
    {
      id: "job-warning",
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryName: "ollama",
      organizationId: null,
      organizationName: null,
      details:
        "12 releases deleted by the release filters; the destination now has none. Check the include/exclude tag patterns and the pre-release setting.",
      status: "warning",
      message: "All releases removed from mirrors/ollama",
      timestamp: new Date("2026-10-29T12:00:05.000Z"),
      jobType: "mirror",
      batchId: null,
      totalItems: null,
      completedItems: 0,
      itemIds: null,
      completedItemIds: [],
      inProgress: false,
      startedAt: null,
      completedAt: null,
      lastCheckpoint: null,
    },
    {
      id: "job-mirrored",
      userId: "user-1",
      repositoryId: "repo-2",
      repositoryName: "other",
      organizationId: null,
      organizationName: null,
      details: null,
      status: "mirrored",
      message: "Successfully mirrored repository: other",
      timestamp: new Date("2026-10-29T11:00:02.000Z"),
      jobType: "mirror",
      batchId: null,
      totalItems: null,
      completedItems: 0,
      itemIds: null,
      completedItemIds: [],
      inProgress: false,
      startedAt: null,
      completedAt: null,
      lastCheckpoint: null,
    },
  ];

  mock.module("@/lib/db", () => ({
    db: {
      select: () => {
        const query: any = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: async () => rows,
          then: (resolve: (value: unknown) => void) => resolve(rows),
        };
        return query;
      },
    },
    mirrorJobs,
  }));

  mock.module("@/lib/auth-guards", () => ({
    requireAuthenticatedUserId: async () => ({ userId: "user-1" }),
  }));

  const { GET } = await import("./index");

  test("activity feed returns warning jobs instead of failing", async () => {
    const response = await GET({
      request: new Request("http://localhost/api/activities?userId=user-1"),
      locals: {},
    } as any);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.activities.map((entry: any) => entry.status)).toEqual(["warning", "mirrored"]);
    expect(body.activities[0].repositoryName).toBe("ollama");
    expect(body.activities[0].message).toBe("All releases removed from mirrors/ollama");
  });
}
