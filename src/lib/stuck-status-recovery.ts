/**
 * Stuck in-flight status recovery (issue #339).
 *
 * Repositories are marked "mirroring"/"syncing" (organizations: "mirroring")
 * in the DB before long-running network work starts. Every in-process failure
 * path resets the status via catch blocks, but a hard interruption (container
 * restart, OOM kill, host reboot, deploy) kills the process before the catch
 * runs and leaves the row stuck in an in-flight status forever:
 *
 *   - the scheduler's sync pool only selects mirrored/synced/failed/pending
 *     (scheduler-service.ts), so a stuck repo is never picked up again;
 *   - the UI disables the Sync/Mirror button for in-flight statuses
 *     (RepositoryTable.tsx), so the user cannot restart it either;
 *   - job-level recovery (recovery.ts) only reconciles mirrorJobs rows — the
 *     scheduler's sync path does not create resilient job records at all, so
 *     an interrupted scheduled sync leaves nothing for recovery to find.
 *
 * This module resets those orphaned rows to "failed" (with an explanatory
 * errorMessage) so the scheduler's next run and the UI's Retry button can
 * pick them up again. It is invoked from:
 *
 *   1. the scheduler loop (every minute) — heals stuck rows at runtime;
 *   2. initializeRecovery() — heals on the startup/middleware recovery path;
 *   3. scripts/startup-recovery.ts — heals before the app starts serving.
 *
 * Cutoff semantics: a row is only reset when its updatedAt is older than
 * max(process start, now - 2h). Rows written by the current process are
 * therefore never touched while the process is younger than the threshold,
 * and long-lived processes use the same 2-hour staleness window that
 * isRepoCurrentlyMirroring (gitea.ts) already applies to in-flight statuses.
 */

import { db, repositories, organizations } from "@/lib/db";
import { inArray, eq } from "drizzle-orm";
import { repoStatusEnum } from "@/types/Repository";
import { createMirrorJob } from "@/lib/helpers";

/** Repository statuses that indicate in-flight work. */
export const IN_FLIGHT_REPO_STATUSES = ["mirroring", "syncing"] as const;

/** Organization statuses that indicate in-flight work. */
export const IN_FLIGHT_ORG_STATUSES = ["mirroring"] as const;

/**
 * How long an in-flight status may go without an update before it is
 * considered stuck. Matches the 2-hour staleness window used by
 * isRepoCurrentlyMirroring in gitea.ts.
 */
export const STUCK_IN_FLIGHT_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Captured at module load, before any request handling can start a mirror or
 * sync in this process. Any in-flight row older than this was written by a
 * previous (crashed/restarted) process.
 */
const PROCESS_START = new Date();

export function getProcessStart(): Date {
  return PROCESS_START;
}

/**
 * Compute the cutoff before which an in-flight status counts as stuck:
 * max(processStart, now - threshold).
 *
 * - Early in the process lifetime the cutoff is the process start, so rows
 *   stuck by a PREVIOUS process are reset immediately after a restart while
 *   rows written by THIS process are never touched.
 * - Once the process has been up longer than the threshold, the cutoff is
 *   now - threshold, healing operations that stalled at runtime.
 */
export function computeStuckStatusCutoff(
  now: Date,
  processStart: Date = PROCESS_START,
  thresholdMs: number = STUCK_IN_FLIGHT_THRESHOLD_MS
): Date {
  return new Date(Math.max(processStart.getTime(), now.getTime() - thresholdMs));
}

/**
 * Whether a row with an in-flight status counts as stuck relative to the
 * cutoff. A missing updatedAt is treated as stuck (nothing can prove the
 * work is still alive).
 */
export function isStuckInFlight(
  row: { status: string; updatedAt: Date | null },
  cutoff: Date
): boolean {
  if (
    !(IN_FLIGHT_REPO_STATUSES as readonly string[]).includes(row.status) &&
    !(IN_FLIGHT_ORG_STATUSES as readonly string[]).includes(row.status)
  ) {
    return false;
  }
  if (!row.updatedAt) {
    return true;
  }
  return new Date(row.updatedAt).getTime() < cutoff.getTime();
}

/** Human-readable explanation stored in errorMessage on reset. */
export function buildStuckResetErrorMessage(previousStatus: string): string {
  const operation = previousStatus === "syncing" ? "sync" : "mirror";
  return (
    `Detected interrupted ${operation}: status was stuck at "${previousStatus}" ` +
    `(the application was likely restarted or crashed mid-operation). ` +
    `The status was reset automatically; the next scheduled run will retry, ` +
    `or you can use Retry to run it now.`
  );
}

/** The DB update payload applied to a stuck row. */
export function buildStuckResetUpdate(
  previousStatus: string,
  now: Date
): { status: "failed"; errorMessage: string; updatedAt: Date } {
  return {
    status: repoStatusEnum.parse("failed") as "failed",
    errorMessage: buildStuckResetErrorMessage(previousStatus),
    updatedAt: now,
  };
}

export interface StuckStatusResetResult {
  repositories: number;
  organizations: number;
}

/**
 * Reset repositories and organizations stuck in an in-flight status to
 * "failed" so the scheduler and the UI's Retry action can pick them up.
 *
 * Never throws: errors are logged and reflected as zero counts so callers
 * (scheduler loop, recovery) are never blocked by this housekeeping step.
 */
export async function resetStuckMirrorStatuses(options: {
  cutoff?: Date;
  now?: Date;
} = {}): Promise<StuckStatusResetResult> {
  const now = options.now ?? new Date();
  const cutoff = options.cutoff ?? computeStuckStatusCutoff(now);
  const result: StuckStatusResetResult = { repositories: 0, organizations: 0 };

  // --- Repositories ---
  try {
    const inFlightRepos = await db
      .select({
        id: repositories.id,
        userId: repositories.userId,
        name: repositories.name,
        fullName: repositories.fullName,
        status: repositories.status,
        updatedAt: repositories.updatedAt,
      })
      .from(repositories)
      .where(inArray(repositories.status, [...IN_FLIGHT_REPO_STATUSES]));

    const stuckRepos = inFlightRepos.filter((repo) =>
      isStuckInFlight(repo, cutoff)
    );

    for (const repo of stuckRepos) {
      await db
        .update(repositories)
        .set(buildStuckResetUpdate(repo.status, now))
        .where(eq(repositories.id, repo.id));

      // Activity-log entry + SSE event so the UI updates live. Push
      // notifications are skipped: a restart can reset many rows at once
      // and this is internal housekeeping, not a user-triggered failure.
      await createMirrorJob({
        userId: repo.userId,
        repositoryId: repo.id,
        repositoryName: repo.name,
        message: `Reset stuck repository status: ${repo.fullName ?? repo.name}`,
        details:
          `Repository was stuck at "${repo.status}" since ` +
          `${repo.updatedAt ? new Date(repo.updatedAt).toISOString() : "an unknown time"} ` +
          `with no active job — most likely an application restart or crash interrupted it. ` +
          `Status was reset to "failed" so it can be retried.`,
        status: "failed",
        skipNotification: true,
      });

      console.log(
        `[StuckStatusRecovery] Reset repository ${repo.fullName ?? repo.name} from "${repo.status}" to "failed" (stuck since ${
          repo.updatedAt ? new Date(repo.updatedAt).toISOString() : "unknown"
        })`
      );
    }

    result.repositories = stuckRepos.length;
  } catch (error) {
    console.error(
      "[StuckStatusRecovery] Failed to reset stuck repository statuses:",
      error
    );
  }

  // --- Organizations ---
  try {
    const inFlightOrgs = await db
      .select({
        id: organizations.id,
        userId: organizations.userId,
        name: organizations.name,
        status: organizations.status,
        updatedAt: organizations.updatedAt,
      })
      .from(organizations)
      .where(inArray(organizations.status, [...IN_FLIGHT_ORG_STATUSES]));

    const stuckOrgs = inFlightOrgs.filter((org) => isStuckInFlight(org, cutoff));

    for (const org of stuckOrgs) {
      await db
        .update(organizations)
        .set(buildStuckResetUpdate(org.status, now))
        .where(eq(organizations.id, org.id));

      await createMirrorJob({
        userId: org.userId,
        organizationId: org.id,
        organizationName: org.name,
        message: `Reset stuck organization status: ${org.name}`,
        details:
          `Organization was stuck at "${org.status}" since ` +
          `${org.updatedAt ? new Date(org.updatedAt).toISOString() : "an unknown time"} ` +
          `with no active job — most likely an application restart or crash interrupted it. ` +
          `Status was reset to "failed" so it can be retried.`,
        status: "failed",
        skipNotification: true,
      });

      console.log(
        `[StuckStatusRecovery] Reset organization ${org.name} from "${org.status}" to "failed" (stuck since ${
          org.updatedAt ? new Date(org.updatedAt).toISOString() : "unknown"
        })`
      );
    }

    result.organizations = stuckOrgs.length;
  } catch (error) {
    console.error(
      "[StuckStatusRecovery] Failed to reset stuck organization statuses:",
      error
    );
  }

  return result;
}
