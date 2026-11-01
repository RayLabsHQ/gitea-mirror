import type { MirrorSyncRequestState } from "./metadata-state";

/**
 * How long a mirror sync request may wait before it counts as stalled.
 * A healthy Gitea runs a queued pull within seconds; this leaves room for
 * a long queue after a large import or a slow fetch of a big repository.
 */
export const MIRROR_SYNC_STALL_THRESHOLD_MS = 60 * 60 * 1000;

export interface MirrorSyncAssessment {
  /** What to store after this sync's request; undefined clears the record. */
  next?: MirrorSyncRequestState;
  /** Set when a request has waited past the threshold and was not reported yet. */
  stalled?: {
    requestedAt: string;
    mirrorUpdated: string;
    waitedMs: number;
  };
}

/**
 * Compare Gitea's `mirror_updated` with the value read before the last
 * request (#493). Gitea moves it on every mirror run it processes, failed
 * runs included, so an unchanged value means the request never ran. Both
 * values come from Gitea's clock, which keeps clock skew between the two
 * hosts out of the comparison.
 *
 * A request that is still waiting is kept as is, so repeated syncs do not
 * reset its age, and it is reported once.
 */
export function assessMirrorSyncRequest({
  previous,
  mirrorUpdated,
  now = new Date(),
}: {
  previous?: MirrorSyncRequestState;
  /** `mirror_updated` from the repository GET that came before this request. */
  mirrorUpdated?: string | null;
  now?: Date;
}): MirrorSyncAssessment {
  if (typeof mirrorUpdated !== "string" || !Number.isFinite(Date.parse(mirrorUpdated))) {
    return {};
  }

  const waiting =
    previous !== undefined &&
    Date.parse(mirrorUpdated) <= Date.parse(previous.mirrorUpdatedBefore);

  if (!waiting) {
    return {
      next: { requestedAt: now.toISOString(), mirrorUpdatedBefore: mirrorUpdated },
    };
  }

  const waitedMs = now.getTime() - Date.parse(previous.requestedAt);
  if (previous.warnedAt || waitedMs < MIRROR_SYNC_STALL_THRESHOLD_MS) {
    return { next: previous };
  }

  return {
    next: { ...previous, warnedAt: now.toISOString() },
    stalled: { requestedAt: previous.requestedAt, mirrorUpdated, waitedMs },
  };
}

/** "45 minutes", "3 hours", "6 days": rounded down, for alert text. */
export function formatWaitedTime(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** Where to look in Gitea or Forgejo, shared by the activity row and the notification. */
export const STUCK_MIRROR_QUEUE_HINT =
  "Gitea accepts sync requests before running them, so this usually means its mirror queue is stuck." +
  ' In Gitea, open Site Administration > Monitoring > Queues > mirror; "Remove all" clears a stuck queue.';
