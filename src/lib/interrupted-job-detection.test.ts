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
  STALE_JOB_AGE_MS,
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

describe("computeInterruptedJobCutoffs", () => {
  test("keeps the 10 minute checkpoint window and 2 hour stale window", () => {
    expect(INTERRUPTED_CHECKPOINT_AGE_MS).toBe(10 * MINUTE);
    expect(STALE_JOB_AGE_MS).toBe(2 * HOUR);

    const cutoffs = computeInterruptedJobCutoffs(NOW);

    expect(cutoffs.checkpointCutoff.getTime()).toBe(NOW.getTime() - 10 * MINUTE);
    expect(cutoffs.staleCutoff.getTime()).toBe(NOW.getTime() - 2 * HOUR);
  });

  test("heartbeat interval leaves room for a missed beat inside the checkpoint window", () => {
    expect(JOB_HEARTBEAT_INTERVAL_MS * 2).toBeLessThanOrEqual(INTERRUPTED_CHECKPOINT_AGE_MS);
  });
});

describe("isJobInterrupted", () => {
  test("a job that just started with no checkpoint is live (regression for #372)", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(MINUTE), lastCheckpoint: null }, NOW)
    ).toBe(false);
  });

  test("a job with no checkpoint is interrupted once it is older than the checkpoint window", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(11 * MINUTE), lastCheckpoint: null }, NOW)
    ).toBe(true);
  });

  test("a legacy row with neither checkpoint nor start time is interrupted", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: null, lastCheckpoint: null }, NOW)
    ).toBe(true);
  });

  test("a fresh checkpoint keeps a job live", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(HOUR), lastCheckpoint: ago(2 * MINUTE) }, NOW)
    ).toBe(false);
  });

  test("a checkpoint older than the window marks the job interrupted", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(HOUR), lastCheckpoint: ago(11 * MINUTE) }, NOW)
    ).toBe(true);
  });

  test("a job running past the stale window is interrupted even with a fresh checkpoint", () => {
    expect(
      isJobInterrupted({ inProgress: true, startedAt: ago(3 * HOUR), lastCheckpoint: ago(MINUTE) }, NOW)
    ).toBe(true);
  });

  test("jobs that are not in progress are never interrupted", () => {
    expect(
      isJobInterrupted({ inProgress: false, startedAt: ago(3 * HOUR), lastCheckpoint: null }, NOW)
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
      .where(buildInterruptedJobsCondition(mirrorJobs, NOW));
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
      .filter((row) => isJobInterrupted(row, NOW))
      .map((row) => row.id)
      .sort();

    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(rows.length);
    expect(await findInterruptedIds()).toEqual(expected);
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
