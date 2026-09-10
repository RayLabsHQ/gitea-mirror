/**
 * Atomic claim of a repository row for an in-flight operation (issue #417).
 *
 * Mirroring and syncing both used to read the row's status, decide the
 * repository was free, and then write the in-flight status in a second
 * statement. Two workers that started in the same tick both read "free" and
 * both went on to mirror the same repository, which is one of the ways release
 * assets ended up duplicated on the destination.
 *
 * The claim below is a single conditional UPDATE: the row moves into the
 * in-flight status only if it is not already "mirroring" or "syncing", and the
 * caller learns from the returned rows whether it won. A row whose in-flight
 * status has gone stale (older than the same two-hour window
 * isRepoCurrentlyMirroring has always used) can be taken over, so a process
 * that died mid-operation never locks a repository out permanently. Rows like
 * that are also reset to "failed" by resetStuckMirrorStatuses
 * (src/lib/stuck-status-recovery.ts), which runs on startup, in recovery and in
 * the scheduler loop.
 */

import { and, eq, lt, notInArray, or, type SQL } from "drizzle-orm";
import { db, repositories } from "@/lib/db";
import {
  IN_FLIGHT_REPO_STATUSES,
  STUCK_IN_FLIGHT_THRESHOLD_MS,
} from "@/lib/stuck-status-recovery";

/**
 * WHERE clause that matches one repository row only while no other run owns it.
 */
export function repositoryClaimCondition(
  repositoryId: string,
  now: Date = new Date()
): SQL | undefined {
  const staleCutoff = new Date(now.getTime() - STUCK_IN_FLIGHT_THRESHOLD_MS);

  return and(
    eq(repositories.id, repositoryId),
    or(
      notInArray(repositories.status, [...IN_FLIGHT_REPO_STATUSES]),
      lt(repositories.updatedAt, staleCutoff)
    )
  );
}

/**
 * Move one repository row into an in-flight status, but only if no other run
 * already owns it. Returns true when this caller claimed the row and false when
 * another mirror or sync is in flight for it.
 */
export async function claimRepositoryForInFlightWork({
  repositoryId,
  set,
  now,
}: {
  repositoryId: string;
  /** The full update payload, including the in-flight status itself. */
  set: Partial<typeof repositories.$inferInsert>;
  now?: Date;
}): Promise<boolean> {
  const claimed = await db
    .update(repositories)
    .set(set)
    .where(repositoryClaimCondition(repositoryId, now))
    .returning({ id: repositories.id });

  return claimed.length > 0;
}
