/**
 * When database maintenance runs. It removes activity log entries and events
 * older than the retention period, and runs more often for a short period.
 * Shared by the background service, the config save and the settings card so
 * the three always agree (#548).
 */

const HOUR_MS = 60 * 60 * 1000;

/** Hours between runs for a retention period given in seconds. */
export function cleanupIntervalHours(retentionSeconds: number): number {
  const days = retentionSeconds / 86400;
  if (days <= 1) return 6;
  if (days <= 3) return 12;
  if (days <= 7) return 24;
  if (days <= 30) return 48;
  return 168;
}

/** "every 6 hours", "daily", "weekly" for the settings card. */
export function cleanupFrequencyText(retentionSeconds: number): string {
  const hours = cleanupIntervalHours(retentionSeconds);
  if (hours === 24) return "daily";
  if (hours === 168) return "weekly";
  if (hours % 24 === 0) return `every ${hours / 24} days`;
  return `every ${hours} hours`;
}

function toTime(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const time = new Date(value as string | number | Date).getTime();
  return Number.isFinite(time) ? time : undefined;
}

/**
 * The next run to store when the settings are saved.
 *
 * The next run used to stay where the old retention period put it, so
 * shortening the period from a month to a day still waited up to a week
 * before the first run on the new schedule (#548). Now:
 * - turning maintenance on, or having no next run, schedules one a full
 *   interval from now;
 * - changing the retention period brings the next run forward when the new
 *   interval ends sooner, and never pushes a run that is already due later;
 * - anything else keeps the stored next run.
 */
export function nextCleanupRun({
  enabled,
  retentionSeconds,
  previous,
  now = new Date(),
}: {
  enabled: boolean;
  retentionSeconds: number;
  previous?: { enabled?: boolean; retentionDays?: number; nextRun?: unknown };
  now?: Date;
}): Date | undefined {
  const stored = toTime(previous?.nextRun);
  if (!enabled) return stored === undefined ? undefined : new Date(stored);

  const fromNow = now.getTime() + cleanupIntervalHours(retentionSeconds) * HOUR_MS;
  const turnedOn = previous !== undefined && !previous.enabled;
  if (stored === undefined || turnedOn) return new Date(fromNow);

  const retentionChanged =
    previous?.retentionDays !== undefined && previous.retentionDays !== retentionSeconds;
  if (retentionChanged) return new Date(Math.min(stored, fromNow));
  return new Date(stored);
}
