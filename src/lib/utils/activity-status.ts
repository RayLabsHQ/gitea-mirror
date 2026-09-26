/**
 * Current state per repository or organization for the Activity Log
 * summary chips. Activities arrive newest first, so the first event seen
 * for a subject is its state.
 *
 * Timestamps are stored to the second, and a quick sync writes its
 * "syncing" and "synced" events in the same second (#454). When the newest
 * event for a subject says work started, an event from the same second
 * that says it finished wins, whatever order the tie came back in.
 */

const IN_PROGRESS_STATUSES = new Set(["syncing", "mirroring", "deleting"]);

interface ActivityLike {
  status: string;
  timestamp: Date | string | number;
  repositoryId?: string | null;
  organizationId?: string | null;
  repositoryName?: string | null;
  organizationName?: string | null;
}

function toSecond(timestamp: ActivityLike["timestamp"]): number {
  return Math.floor(new Date(timestamp).getTime() / 1000);
}

export function latestStatusBySubject(activities: ActivityLike[]): Map<string, string> {
  const latest = new Map<string, { status: string; second: number }>();
  for (const activity of activities) {
    const subject =
      activity.repositoryId ||
      activity.organizationId ||
      activity.repositoryName ||
      activity.organizationName;
    // Events with no subject have no state of their own to report.
    if (!subject) continue;

    const second = toSecond(activity.timestamp);
    const seen = latest.get(subject);
    if (!seen) {
      latest.set(subject, { status: activity.status, second });
      continue;
    }
    if (
      IN_PROGRESS_STATUSES.has(seen.status) &&
      !IN_PROGRESS_STATUSES.has(activity.status) &&
      seen.second === second
    ) {
      latest.set(subject, { status: activity.status, second });
    }
  }

  return new Map([...latest].map(([subject, { status }]) => [subject, status]));
}

export function countLatestStatuses(activities: ActivityLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  latestStatusBySubject(activities).forEach((status) => {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  });
  return counts;
}
