/**
 * Decides which in-progress mirror jobs count as interrupted and should be
 * resumed by recovery (issue #372).
 *
 * A job is interrupted when any of these hold:
 *   - it has a checkpoint older than the checkpoint window, or
 *   - it has no checkpoint and is older than the checkpoint window (or has
 *     no recorded start at all, as legacy rows may), or
 *   - it started longer ago than the stale window, whatever its checkpoint.
 *
 * The grace period for jobs without a checkpoint is the point of this
 * module. Checkpoints are written when an item completes, so a job that has
 * just started, or is on a single long item, has none yet. Treating "no
 * checkpoint" as "interrupted" made request-time recovery resume jobs that
 * were still running.
 *
 * The rule exists twice on purpose: `isJobInterrupted` is the readable,
 * directly testable form, and `buildInterruptedJobsCondition` is the SQL
 * used by `findInterruptedJobs`. The test suite checks they agree.
 */
import { and, eq, isNull, lt, or, type SQL } from "drizzle-orm";
import type { mirrorJobs } from "@/lib/db/schema";

/** A job with no checkpoint newer than this is considered inactive. */
export const INTERRUPTED_CHECKPOINT_AGE_MS = 10 * 60 * 1000;

/** A job that started longer ago than this is considered stale regardless. */
export const STALE_JOB_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * How often a running job refreshes its checkpoint between item
 * completions. Kept well inside the checkpoint window so one missed beat
 * does not make a live job look interrupted.
 */
export const JOB_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

export interface InterruptedJobCutoffs {
  /** Checkpoints (or starts, for jobs without one) before this are too old. */
  checkpointCutoff: Date;
  /** Starts before this mark the job stale no matter what. */
  staleCutoff: Date;
}

export function computeInterruptedJobCutoffs(now: Date = new Date()): InterruptedJobCutoffs {
  return {
    checkpointCutoff: new Date(now.getTime() - INTERRUPTED_CHECKPOINT_AGE_MS),
    staleCutoff: new Date(now.getTime() - STALE_JOB_AGE_MS),
  };
}

export interface JobLivenessFields {
  inProgress: boolean | null | undefined;
  startedAt: Date | null | undefined;
  lastCheckpoint: Date | null | undefined;
}

/**
 * Pure form of the interrupted-job rule. Must stay equivalent to
 * `buildInterruptedJobsCondition`.
 */
export function isJobInterrupted(job: JobLivenessFields, now: Date = new Date()): boolean {
  if (!job.inProgress) return false;

  const { checkpointCutoff, staleCutoff } = computeInterruptedJobCutoffs(now);

  if (job.startedAt && job.startedAt < staleCutoff) return true;

  if (job.lastCheckpoint) return job.lastCheckpoint < checkpointCutoff;

  // No checkpoint yet: give the job the same window it would get after a
  // checkpoint. A row with no start time either has nothing to prove it
  // is alive, so it is treated as interrupted.
  return !job.startedAt || job.startedAt < checkpointCutoff;
}

/**
 * SQL form of the interrupted-job rule for `findInterruptedJobs`. Takes the
 * table so tests can run it against an in-memory database without the
 * application database module.
 */
export function buildInterruptedJobsCondition(
  table: typeof mirrorJobs,
  now: Date = new Date(),
): SQL {
  const { checkpointCutoff, staleCutoff } = computeInterruptedJobCutoffs(now);

  return and(
    eq(table.inProgress, true),
    or(
      // No checkpoint yet, and old enough that one should exist by now
      // (or no recorded start to judge by).
      and(
        isNull(table.lastCheckpoint),
        or(isNull(table.startedAt), lt(table.startedAt, checkpointCutoff)),
      ),
      // Checkpoint present but too old.
      lt(table.lastCheckpoint, checkpointCutoff),
      // Running far too long, whatever the checkpoint says.
      lt(table.startedAt, staleCutoff),
    ),
  )!;
}
