import { describe, expect, test } from "bun:test";
import { cleanupFrequencyText, cleanupIntervalHours, nextCleanupRun } from "./cleanup-schedule";

const DAY = 86400;
const HOUR_MS = 60 * 60 * 1000;
const now = new Date("2026-11-24T12:00:00Z");

describe("cleanupIntervalHours", () => {
  test("runs more often for a short retention period", () => {
    expect(cleanupIntervalHours(1 * DAY)).toBe(6);
    expect(cleanupIntervalHours(3 * DAY)).toBe(12);
    expect(cleanupIntervalHours(7 * DAY)).toBe(24);
    expect(cleanupIntervalHours(30 * DAY)).toBe(48);
    expect(cleanupIntervalHours(90 * DAY)).toBe(168);
  });

  test("reads as text on the settings card", () => {
    expect(cleanupFrequencyText(1 * DAY)).toBe("every 6 hours");
    expect(cleanupFrequencyText(3 * DAY)).toBe("every 12 hours");
    expect(cleanupFrequencyText(7 * DAY)).toBe("daily");
    expect(cleanupFrequencyText(30 * DAY)).toBe("every 2 days");
    expect(cleanupFrequencyText(90 * DAY)).toBe("weekly");
  });
});

describe("nextCleanupRun (#548)", () => {
  test("shortening the retention period brings the next run forward", () => {
    const weekAway = new Date(now.getTime() + 168 * HOUR_MS);
    const next = nextCleanupRun({
      enabled: true,
      retentionSeconds: 1 * DAY,
      previous: { enabled: true, retentionDays: 90 * DAY, nextRun: weekAway },
      now,
    });
    expect(next).toEqual(new Date(now.getTime() + 6 * HOUR_MS));
  });

  test("lengthening the retention period never pushes a due run later", () => {
    const soon = new Date(now.getTime() + 2 * HOUR_MS);
    const next = nextCleanupRun({
      enabled: true,
      retentionSeconds: 90 * DAY,
      previous: { enabled: true, retentionDays: 1 * DAY, nextRun: soon },
      now,
    });
    expect(next).toEqual(soon);
  });

  test("saving other settings keeps the stored next run", () => {
    const stored = new Date(now.getTime() + 20 * HOUR_MS);
    const next = nextCleanupRun({
      enabled: true,
      retentionSeconds: 7 * DAY,
      previous: { enabled: true, retentionDays: 7 * DAY, nextRun: stored.toISOString() },
      now,
    });
    expect(next).toEqual(stored);
  });

  test("turning maintenance on schedules a full interval from now", () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const next = nextCleanupRun({
      enabled: true,
      retentionSeconds: 3 * DAY,
      previous: { enabled: false, retentionDays: 3 * DAY, nextRun: old },
      now,
    });
    expect(next).toEqual(new Date(now.getTime() + 12 * HOUR_MS));
  });

  test("schedules one when none is stored", () => {
    expect(
      nextCleanupRun({ enabled: true, retentionSeconds: 7 * DAY, previous: { enabled: true }, now })
    ).toEqual(new Date(now.getTime() + 24 * HOUR_MS));
    expect(nextCleanupRun({ enabled: true, retentionSeconds: 7 * DAY, now })).toEqual(
      new Date(now.getTime() + 24 * HOUR_MS)
    );
  });

  test("turned off it keeps whatever was stored", () => {
    const stored = new Date(now.getTime() + 5 * HOUR_MS);
    expect(
      nextCleanupRun({ enabled: false, retentionSeconds: DAY, previous: { enabled: true, nextRun: stored }, now })
    ).toEqual(stored);
    expect(nextCleanupRun({ enabled: false, retentionSeconds: DAY, previous: { enabled: true }, now })).toBeUndefined();
  });
});
