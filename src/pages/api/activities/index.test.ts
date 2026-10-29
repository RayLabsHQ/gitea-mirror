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
  const rows = [
    {
      id: "job-warning",
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryName: "ollama",
      status: "warning",
      triggerType: "automatic",
      mirrorType: "github-to-gitea",
      giteaRepoName: "ollama",
      startTime: "2026-10-29T12:00:00.000Z",
      endTime: "2026-10-29T12:00:05.000Z",
      duration: 5000,
      error: "All releases removed from ollama",
      log: null,
    },
    {
      id: "job-mirrored",
      userId: "user-1",
      repositoryId: "repo-2",
      repositoryName: "other",
      status: "mirrored",
      triggerType: "manual",
      mirrorType: "github-to-gitea",
      giteaRepoName: "other",
      startTime: "2026-10-29T11:00:00.000Z",
      endTime: "2026-10-29T11:00:02.000Z",
      duration: 2000,
      error: null,
      log: null,
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
  });
}
