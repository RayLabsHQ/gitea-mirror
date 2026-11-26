/**
 * Tests for interrupted-job detection (issue #372).
 *
 * A job that had just started, with `inProgress=true` and no checkpoint yet,
 * matched `findInterruptedJobs` immediately, so request-time recovery
 * "resumed" jobs that were still running. The rule now lives in
 * interrupted-job-detection.ts, both as a predicate and as the SQL condition
 * used by findInterruptedJobs. The SQL is exercised against a real in-memory
 * SQLite database. The wiring into helpers.ts, concurrency.ts, and
 * middleware.ts is asserted by reading the source, following the convention
 * in orchestrator-resume-after-startup.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mirrorJobs } from "@/lib/db/schema";
import {
  INTERRUPTED_CHECKPOINT_AGE_MS,
  JOB_HEARTBEAT_INTERVAL_MS,
  computeInterruptedJobCutoffs,
  isJobInterrupted,
  buildInterruptedJobsCondition,
  type JobLivenessFields,
} from "./interrupted-job-detection";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
// Most cases model a process that has been up for days, so only the
// checkpoint window decides. Jobs left by an earlier process are covered
// in their own block below (#564).
const LONG_RUNNING = ago(48 * HOUR);

describe("computeInterruptedJobCutoffs", () => {
  test("keeps the 10 minute checkpoint window and has no stale age cutoff", () => {
    expect(INTERRUPTED_CHECKPOINT_AGE_MS).toBe(10 * MINUTE);

    const cutoffs = computeInterruptedJobCutoffs(NOW, LONG_RUNNING);

    expect(cutoffs.checkpointCutoff.getTime()).toBe(NOW.getTime() - 10 * MINUTE);
    // The two hour "stale regardless of checkpoint" rule resumed live jobs
    // and is gone; a checkpointing job is alive however old it is.
    expect(Object.keys(cutoffs)).toEqual(["checkpointCutoff"]);
  });

  test("heartbeat interval leaves room for a missed beat inside the checkpoint window", () => {
    expect(JOB_HEARTBEAT_INTERVAL_MS * 2).toBeLessThanOrEqual(INTERRUPTED_CHECKPOINT_AGE_MS);
  });
});

describe("isJobInterrupted", () => {
  test("a job that just started with no checkpoint is live (regression for #372)", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(MINUTE), lastCheckpoint: null }, NOW, LONG_RUNNING)
    ).toBe(false);
  });

  test("a job with no checkpoint is interrupted once it is older than the checkpoint window", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(11 * MINUTE), lastCheckpoint: null }, NOW, LONG_RUNNING)
    ).toBe(true);
  });

  test("a legacy row with neither checkpoint nor start time is interrupted", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: null, lastCheckpoint: null }, NOW, LONG_RUNNING)
    ).toBe(true);
  });

  test("a fresh checkpoint keeps a job live", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(HOUR), lastCheckpoint: ago(2 * MINUTE) }, NOW, LONG_RUNNING)
    ).toBe(false);
  });

  test("a checkpoint older than the window marks the job interrupted", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(HOUR), lastCheckpoint: ago(11 * MINUTE) }, NOW, LONG_RUNNING)
    ).toBe(true);
  });

  test("a job that keeps checkpointing stays live however long ago it started", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(3 * HOUR), lastCheckpoint: ago(MINUTE) }, NOW, LONG_RUNNING)
    ).toBe(false);
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(30 * HOUR), lastCheckpoint: ago(2 * MINUTE) }, NOW, LONG_RUNNING)
    ).toBe(false);
  });

  test("an old job whose checkpoint went stale is still interrupted", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(3 * HOUR), lastCheckpoint: ago(11 * MINUTE) }, NOW, LONG_RUNNING)
    ).toBe(true);
  });

  test("jobs that are not in progress are never interrupted", () => {
    expect(
      isJobInterrupted({ inProgress: false, startedAt: ago(3 * HOUR), lastCheckpoint: null }, NOW, LONG_RUNNING)
    ).toBe(false);
  });
});

describe("buildInterruptedJobsCondition", () => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);

  beforeAll(() => {
    // Only the columns the condition and the projection touch. The schema's
    // other columns are irrelevant here and would need seeding otherwise.
    sqlite.run(
      "CREATE TABLE mirror_jobs (id TEXT PRIMARY KEY, in_progress INTEGER NOT NULL DEFAULT 0, started_at INTEGER, last_checkpoint INTEGER)"
    );
  });

  afterAll(() => {
    sqlite.close();
  });

  type Row = JobLivenessFields & { id: string };

  // Drizzle stores `timestamp` mode integers as unix seconds.
  const seconds = (value: Date | null | undefined) =>
    value ? Math.floor(value.getTime() / 1000) : null;

  function seed(rows: Row[]) {
    sqlite.run("DELETE FROM mirror_jobs");
    const insert = sqlite.prepare(
      "INSERT INTO mirror_jobs (id, in_progress, started_at, last_checkpoint) VALUES (?, ?, ?, ?)"
    );
    for (const row of rows) {
      insert.run(row.id, row.inProgress ? 1 : 0, seconds(row.startedAt), seconds(row.lastCheckpoint));
    }
  }

  async function findInterruptedIds() {
    const rows = await db
      .select({ id: mirrorJobs.id })
      .from(mirrorJobs)
      .where(buildInterruptedJobsCondition(mirrorJobs, NOW, LONG_RUNNING));
    return rows.map((row) => row.id).sort();
  }

  test("does not return a job that just started and has no checkpoint yet", async () => {
    seed([
      { id: "just-started", inProgress: true, startedAt: ago(MINUTE), lastCheckpoint: null },
      { id: "first-item-running", inProgress: true, startedAt: ago(9 * MINUTE), lastCheckpoint: null },
    ]);

    expect(await findInterruptedIds()).toEqual([]);
  });

  test("returns jobs whose missing checkpoint is overdue", async () => {
    seed([
      { id: "overdue", inProgress: true, startedAt: ago(11 * MINUTE), lastCheckpoint: null },
      { id: "no-start", inProgress: true, startedAt: null, lastCheckpoint: null },
    ]);

    expect(await findInterruptedIds()).toEqual(["no-start", "overdue"]);
  });

  test("agrees with isJobInterrupted across the whole grid of cases", async () => {
    const starts: Array<[string, Date | null]> = [
      ["s-none", null],
      ["s-1m", ago(MINUTE)],
      ["s-11m", ago(11 * MINUTE)],
      ["s-3h", ago(3 * HOUR)],
    ];
    const checkpoints: Array<[string, Date | null]> = [
      ["c-none", null],
      ["c-2m", ago(2 * MINUTE)],
      ["c-11m", ago(11 * MINUTE)],
    ];

    const rows: Row[] = [];
    for (const inProgress of [true, false]) {
      for (const [startLabel, startedAt] of starts) {
        for (const [checkpointLabel, lastCheckpoint] of checkpoints) {
          rows.push({
            id: `${inProgress ? "live" : "done"}/${startLabel}/${checkpointLabel}`,
            inProgress,
            startedAt,
            lastCheckpoint,
          });
        }
      }
    }
    seed(rows);

    const expected = rows
      .filter((row) => isJobInterrupted(row, NOW, LONG_RUNNING))
      .map((row) => row.id)
      .sort();

    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(rows.length);
    expect(await findInterruptedIds()).toEqual(expected);
  });
});

describe("jobs left by an earlier process (#564)", () => {
  // This process started 30 seconds ago, at 11:59:30.700. The previous one
  // was killed a minute ago, with a checkpoint well inside the window.
  const BOOTED = new Date(NOW.getTime() - 29_300);
  // mirror_jobs keeps whole seconds; this is what a row reads back as.
  const stored = (value: Date) => new Date(Math.floor(value.getTime() / 1000) * 1000);

  test("a job checkpointed by the previous process is resumed at once, not after the window", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(20 * MINUTE), lastCheckpoint: ago(MINUTE) }, NOW, BOOTED)
    ).toBe(true);
    // Before #564 this waited until the checkpoint was 10 minutes old.
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(20 * MINUTE), lastCheckpoint: ago(MINUTE) }, NOW, LONG_RUNNING)
    ).toBe(false);
  });

  test("a job the previous process started but never checkpointed is resumed at once", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(2 * MINUTE), lastCheckpoint: null }, NOW, BOOTED)
    ).toBe(true);
  });

  test("a job this process started is live, even one started in its first second", () => {
    const firstSecond = new Date(BOOTED.getTime() + 200);
    expect(
      isJobInterrupted({ inProgress: true, startedAt: stored(firstSecond), lastCheckpoint: null }, NOW, BOOTED)
    ).toBe(false);
    expect(
      isJobInterrupted(
        { inProgress: true, startedAt: stored(firstSecond), lastCheckpoint: stored(ago(5_000)) },
        NOW,
        BOOTED
      )
    ).toBe(false);
  });

  test("the checkpoint window still applies once the process has been up longer than it", () => {
    const later = new Date(NOW.getTime() + 2 * HOUR);
    const jobStart = new Date(NOW.getTime() + 10 * MINUTE);
    expect(
      isJobInterrupted({ inProgress: true, startedAt: jobStart, lastCheckpoint: new Date(later.getTime() - 11 * MINUTE) }, later, BOOTED)
    ).toBe(true);
    expect(
      isJobInterrupted({ inProgress: true, startedAt: jobStart, lastCheckpoint: new Date(later.getTime() - 2 * MINUTE) }, later, BOOTED)
    ).toBe(false);
  });

  test("the SQL condition agrees, against whole-second rows", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    sqlite.run(
      "CREATE TABLE mirror_jobs (id TEXT PRIMARY KEY, in_progress INTEGER NOT NULL DEFAULT 0, started_at INTEGER, last_checkpoint INTEGER)"
    );
    const firstSecond = new Date(BOOTED.getTime() + 200);
    const rows: Array<JobLivenessFields & { id: string }> = [
      { id: "previous-checkpointed", inProgress: true, startedAt: ago(20 * MINUTE), lastCheckpoint: ago(MINUTE) },
      { id: "previous-no-checkpoint", inProgress: true, startedAt: ago(2 * MINUTE), lastCheckpoint: null },
      { id: "this-first-second", inProgress: true, startedAt: stored(firstSecond), lastCheckpoint: null },
      { id: "this-checkpointed", inProgress: true, startedAt: stored(firstSecond), lastCheckpoint: stored(ago(5_000)) },
      { id: "previous-finished", inProgress: false, startedAt: ago(20 * MINUTE), lastCheckpoint: ago(MINUTE) },
    ];
    const insert = sqlite.prepare(
      "INSERT INTO mirror_jobs (id, in_progress, started_at, last_checkpoint) VALUES (?, ?, ?, ?)"
    );
    const seconds = (value: Date | null | undefined) => (value ? Math.floor(value.getTime() / 1000) : null);
    for (const row of rows) {
      insert.run(row.id, row.inProgress ? 1 : 0, seconds(row.startedAt), seconds(row.lastCheckpoint));
    }

    const found = (
      await db
        .select({ id: mirrorJobs.id })
        .from(mirrorJobs)
        .where(buildInterruptedJobsCondition(mirrorJobs, NOW, BOOTED))
    )
      .map((row) => row.id)
      .sort();
    const expected = rows
      .filter((row) => isJobInterrupted(row, NOW, BOOTED))
      .map((row) => row.id)
      .sort();

    expect(found).toEqual(["previous-checkpointed", "previous-no-checkpoint"]);
    expect(found).toEqual(expected);
    sqlite.close();
  });
});

describe("wiring", () => {
  const read = (relative: string) => readFileSync(join(import.meta.dir, relative), "utf8");
  const HELPERS_SRC = read("helpers.ts");
  const CONCURRENCY_SRC = read("utils/concurrency.ts");
  const MIDDLEWARE_SRC = read("../middleware.ts");

  test("createMirrorJob writes an initial checkpoint for in-progress jobs", () => {
    expect(
      /lastCheckpoint:\s*inProgress\s*\?\s*currentTimestamp\s*:\s*undefined/.test(HELPERS_SRC),
      "an in-progress job must start with a checkpoint so a null checkpoint means a legacy row, not a new job"
    ).toBe(true);
  });

  test("findInterruptedJobs uses the shared condition instead of a bare null-checkpoint match", () => {
    expect(
      /\.where\(buildInterruptedJobsCondition\(mirrorJobs\)\)/.test(HELPERS_SRC),
      "findInterruptedJobs must query through buildInterruptedJobsCondition"
    ).toBe(true);
    expect(
      /or\(\s*isNull\(mirrorJobs\.lastCheckpoint\)/.test(HELPERS_SRC),
      "a null checkpoint on its own must no longer count as interrupted"
    ).toBe(false);
  });

  test("touchMirrorJobCheckpoint only refreshes rows that are still in progress", () => {
    expect(/export async function touchMirrorJobCheckpoint\(/.test(HELPERS_SRC)).toBe(true);
    expect(
      /set\(\{\s*lastCheckpoint:\s*new Date\(\)\s*\}\)\s*\.where\(and\(eq\(mirrorJobs\.id,\s*jobId\),\s*eq\(mirrorJobs\.inProgress,\s*true\)\)\)/.test(
        HELPERS_SRC
      ),
      "the heartbeat must not revive a job that already completed or failed"
    ).toBe(true);
  });

  test("processWithResilience heartbeats while items run and stops when the job ends", () => {
    expect(
      /setInterval\([\s\S]*?touchMirrorJobCheckpoint\(jobId\)[\s\S]*?JOB_HEARTBEAT_INTERVAL_MS\)/.test(
        CONCURRENCY_SRC
      ),
      "processWithResilience must refresh the checkpoint on a timer"
    ).toBe(true);
    expect(
      /finally\s*\{\s*clearInterval\(heartbeat\);\s*\}/.test(CONCURRENCY_SRC),
      "the heartbeat must be cleared on every exit path"
    ).toBe(true);
  });

  test("resumeInterruptedJob records a fresh start time for the resumed pass", () => {
    const resumeBody = HELPERS_SRC.slice(HELPERS_SRC.indexOf("export async function resumeInterruptedJob("));
    expect(/inProgress:\s*true,\s*startedAt:\s*new Date\(\)/.test(resumeBody)).toBe(true);
  });

  test("updateMirrorJobProgress serializes writes per job so concurrent items cannot drop each other", () => {
    expect(
      /withKeyedLock\(`mirror-job:\$\{params\.jobId\}`,\s*\(\)\s*=>\s*updateMirrorJobProgressLocked\(params\)\)/.test(HELPERS_SRC)
    ).toBe(true);
  });

  test("processWithRetry checkpoints every completed item instead of the one that trips the interval", () => {
    expect(/await onCheckpoint\(jobId,\s*itemId,\s*publish\)/.test(CONCURRENCY_SRC)).toBe(true);
    expect(CONCURRENCY_SRC.includes("onCheckpoint(jobId, 'final')")).toBe(false);
  });

  test("middleware keeps the recovery latch until the recovery promise settles", () => {
    expect(
      /recoveryPromise\s*\.catch\(\(\)\s*=>\s*false\)\s*\.finally\(\(\)\s*=>\s*\{\s*recoveryInFlight\s*=\s*false;\s*\}\)/.test(
        MIDDLEWARE_SRC
      ),
      "the latch must be released by the recovery promise, not by the request that started it"
    ).toBe(true);
    expect(
      /if\s*\(\s*!latchFollowsRecovery\s*\)\s*\{\s*recoveryInFlight\s*=\s*false;\s*\}/.test(MIDDLEWARE_SRC),
      "the request-level finally may only release the latch when recovery never started"
    ).toBe(true);
    expect(
      /clearTimeout\(timeoutHandle\)/.test(MIDDLEWARE_SRC),
      "the bounded wait must not leave a dangling rejection timer"
    ).toBe(true);
  });
});
