import { describe, expect, test } from "bun:test";
import {
  assessMirrorSyncRequest,
  formatWaitedTime,
  MIRROR_SYNC_STALL_THRESHOLD_MS,
} from "./mirror-sync-health";

const HOUR = 60 * 60 * 1000;

describe("assessMirrorSyncRequest", () => {
  const requestedAt = "2026-10-20T08:00:00.000Z";
  const mirrorUpdatedBefore = "2026-10-20T07:55:12Z";
  const previous = { requestedAt, mirrorUpdatedBefore };

  test("records the first request with the mirror_updated read before it", () => {
    const now = new Date("2026-10-20T08:00:00.000Z");
    const result = assessMirrorSyncRequest({ mirrorUpdated: mirrorUpdatedBefore, now });

    expect(result).toEqual({
      next: { requestedAt: now.toISOString(), mirrorUpdatedBefore },
    });
  });

  test("starts a new record once Gitea ran the previous request", () => {
    const now = new Date("2026-10-20T16:00:00.000Z");
    const result = assessMirrorSyncRequest({
      previous,
      mirrorUpdated: "2026-10-20T08:00:03Z",
      now,
    });

    expect(result.stalled).toBeUndefined();
    expect(result.next).toEqual({
      requestedAt: now.toISOString(),
      mirrorUpdatedBefore: "2026-10-20T08:00:03Z",
    });
  });

  test("keeps a waiting request without warning inside the threshold", () => {
    const now = new Date(Date.parse(requestedAt) + MIRROR_SYNC_STALL_THRESHOLD_MS - 1);
    const result = assessMirrorSyncRequest({ previous, mirrorUpdated: mirrorUpdatedBefore, now });

    expect(result).toEqual({ next: previous });
  });

  test("reports a request Gitea has not run past the threshold", () => {
    const now = new Date(Date.parse(requestedAt) + 8 * HOUR);
    const result = assessMirrorSyncRequest({ previous, mirrorUpdated: mirrorUpdatedBefore, now });

    expect(result.stalled).toEqual({
      requestedAt,
      mirrorUpdated: mirrorUpdatedBefore,
      waitedMs: 8 * HOUR,
    });
    expect(result.next).toEqual({ ...previous, warnedAt: now.toISOString() });
  });

  test("keeps the age of the oldest waiting request across frequent syncs", () => {
    // Syncs every 20 minutes: each one finds the same request still waiting
    // and keeps it, so the third hour reports instead of resetting forever.
    let record = previous;
    let reported = 0;
    for (let minutes = 20; minutes <= 180; minutes += 20) {
      const result = assessMirrorSyncRequest({
        previous: record,
        mirrorUpdated: mirrorUpdatedBefore,
        now: new Date(Date.parse(requestedAt) + minutes * 60_000),
      });
      if (result.stalled) reported++;
      record = result.next!;
      expect(record.requestedAt).toBe(requestedAt);
    }

    expect(reported).toBe(1);
  });

  test("reports each waiting request once", () => {
    const warned = { ...previous, warnedAt: "2026-10-20T16:00:00.000Z" };
    const result = assessMirrorSyncRequest({
      previous: warned,
      mirrorUpdated: mirrorUpdatedBefore,
      now: new Date(Date.parse(requestedAt) + 48 * HOUR),
    });

    expect(result).toEqual({ next: warned });
  });

  test("clears the record when Gitea does not report mirror_updated", () => {
    expect(assessMirrorSyncRequest({ previous, mirrorUpdated: undefined })).toEqual({});
    expect(assessMirrorSyncRequest({ previous, mirrorUpdated: "not a date" })).toEqual({});
  });
});

describe("formatWaitedTime", () => {
  test("rounds down to minutes, hours or days", () => {
    expect(formatWaitedTime(10_000)).toBe("1 minute");
    expect(formatWaitedTime(45 * 60_000)).toBe("45 minutes");
    expect(formatWaitedTime(HOUR)).toBe("1 hour");
    expect(formatWaitedTime(47 * HOUR + 59 * 60_000)).toBe("47 hours");
    expect(formatWaitedTime(7 * 24 * HOUR)).toBe("7 days");
  });
});
