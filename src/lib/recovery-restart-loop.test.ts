/**
 * Restart loop (#564): a job whose work kept taking the app down was resumed
 * on every restart, with no end, and a clean stop left jobs that were never
 * resumed at all.
 *
 * Runs against the real schema in an in-memory SQLite database that replaces
 * @/lib/db through mock.module, so the file runs in its own process.
 */
import { describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { runsIsolated } from "@/tests/isolated";
import { buildInterruptedJobsCondition, MAX_RESUMES_WITHOUT_PROGRESS } from "@/lib/interrupted-job-detection";

const isolated = runsIsolated(import.meta.path);

const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite });

if (isolated) {
  const folder = join(process.cwd(), "drizzle");
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    for (const statement of readFileSync(join(folder, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.run(statement);
    }
  }
  sqlite.run("INSERT INTO users (id, email, username, name) VALUES ('u1', 'u1@example.com', 'u1', 'User')");

  // Copy the real exports before mocking: mock.module patches the namespace.
  const realEvents = { ...(await import("@/lib/events")) };
  const realNotifications = { ...(await import("@/lib/notification-service")) };
  mock.module("@/lib/db", () => ({ ...schema, db }));
  mock.module("@/lib/events", () => ({ ...realEvents, publishEvent: async () => undefined }));
  mock.module("@/lib/notification-service", () => ({
    ...realNotifications,
    triggerJobNotification: async () => undefined,
  }));
}

// The test preload replaces @/lib/helpers with a stub. The query string
// loads the real file as a separate module.
const helpers: typeof import("@/lib/helpers") = isolated
  ? await import(`${join(process.cwd(), "src/lib/helpers.ts")}?real`)
  : ({} as typeof import("@/lib/helpers"));
const shutdown = isolated
  ? await import("@/lib/shutdown-manager")
  : ({} as typeof import("@/lib/shutdown-manager"));

async function insertJob(id: string, resumeAttempts = 0) {
  await db.insert(schema.mirrorJobs).values({
    id,
    userId: "u1",
    message: "Mirroring",
    status: "mirroring",
    jobType: "mirror",
    inProgress: true,
    itemIds: ["a", "b", "c"],
    completedItemIds: ["a"],
    completedItems: 1,
    totalItems: 3,
    startedAt: new Date(Date.now() - 20 * 60 * 1000),
    lastCheckpoint: new Date(Date.now() - 60 * 1000),
    resumeAttempts,
  });
}

async function readJob(id: string) {
  const [row] = await db.select().from(schema.mirrorJobs).where(eq(schema.mirrorJobs.id, id));
  return row;
}

describe.skipIf(!isolated)("restart loop (#564)", () => {
  test(`a job resumed ${MAX_RESUMES_WITHOUT_PROGRESS} times without finishing an item is failed, not resumed again`, async () => {
    await insertJob("job-loop");

    for (let attempt = 1; attempt <= MAX_RESUMES_WITHOUT_PROGRESS; attempt++) {
      const resumed = await helpers.resumeInterruptedJob(await readJob("job-loop"));
      expect(resumed?.remainingItemIds).toEqual(["b", "c"]);
      expect((await readJob("job-loop")).resumeAttempts).toBe(attempt);
    }

    // The app went down again before any item finished.
    expect(await helpers.resumeInterruptedJob(await readJob("job-loop"))).toBeNull();

    const job = await readJob("job-loop");
    expect(job.status).toBe("failed");
    expect(job.inProgress).toBe(false);
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(job.message).toContain("without progress");
    // Nothing looks for it any more.
    const found = await db.select({ id: schema.mirrorJobs.id }).from(schema.mirrorJobs)
      .where(buildInterruptedJobsCondition(schema.mirrorJobs, new Date(), new Date()));
    expect(found.map((row) => row.id)).not.toContain("job-loop");
  });

  test("finishing an item gives the job its resumes back", async () => {
    await insertJob("job-progress", MAX_RESUMES_WITHOUT_PROGRESS - 1);

    await helpers.updateMirrorJobProgress({ jobId: "job-progress", completedItemId: "b" });

    const job = await readJob("job-progress");
    expect(job.resumeAttempts).toBe(0);
    expect(job.completedItemIds).toEqual(["a", "b"]);
    // A heartbeat alone is not progress.
    await db.update(schema.mirrorJobs).set({ resumeAttempts: 2 }).where(eq(schema.mirrorJobs.id, "job-progress"));
    await helpers.updateMirrorJobProgress({ jobId: "job-progress", message: "still going" });
    expect((await readJob("job-progress")).resumeAttempts).toBe(2);
  });

  test("a job saved by a clean stop is resumed by the next process", async () => {
    await insertJob("job-stopped");
    const exitCodes: unknown[] = [];
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code);
    }) as never);
    // The preload fires every timer at once, which would fail the save on
    // its own timeout before it runs. Use real timers for the shutdown.
    const fastTimers = globalThis.setTimeout;
    globalThis.setTimeout = (globalThis as any).__originalSetTimeout;
    try {
      shutdown.registerActiveJob("job-stopped");
      await shutdown.gracefulShutdown("SIGTERM");
    } finally {
      globalThis.setTimeout = fastTimers;
      exit.mockRestore();
    }
    expect(exitCodes).toEqual([0]);

    const job = await readJob("job-stopped");
    expect(job.message).toContain("will resume on restart");
    expect(job.inProgress).toBe(true);

    // The next process starts after that checkpoint and picks the job up
    // at once, without waiting out the 10 minute window.
    const nextStart = new Date(Date.now() + 5_000);
    const found = await db.select({ id: schema.mirrorJobs.id }).from(schema.mirrorJobs)
      .where(buildInterruptedJobsCondition(schema.mirrorJobs, new Date(nextStart.getTime() + 1_000), nextStart));
    expect(found.map((row) => row.id)).toContain("job-stopped");
  });
});
