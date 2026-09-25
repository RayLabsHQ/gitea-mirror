/**
 * Incremental metadata sync watermarks (#449): parsing, serialisation and
 * the full vs incremental decision.
 */
import { describe, expect, test } from "bun:test";
import {
  FULL_METADATA_PASS_INTERVAL_MS,
  INCREMENTAL_SYNC_SAFETY_MARGIN_MS,
  advanceMetadataSyncCursor,
  buildPassProgress,
  classifyPassItem,
  createDefaultMetadataState,
  numberInRanges,
  parseRepositoryMetadataState,
  planMetadataPass,
  planMetadataPassWithProgress,
  serializeRepositoryMetadataState,
  toNumberRanges,
} from "./metadata-state";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("sync cursor parsing", () => {
  test("a row written before #449 loads with no cursors", () => {
    const legacy = JSON.stringify({
      components: { releases: true, issues: true, pullRequests: true, labels: true, milestones: true },
      lastSyncedAt: "2026-09-01T00:00:00.000Z",
    });
    const state = parseRepositoryMetadataState(legacy);
    expect(state.syncCursors).toEqual({});
    expect(state.components.issues).toBe(true);
    expect(state.lastSyncedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("the default state has no cursors", () => {
    expect(createDefaultMetadataState().syncCursors).toEqual({});
    expect(parseRepositoryMetadataState(null).syncCursors).toEqual({});
    expect(parseRepositoryMetadataState("not json").syncCursors).toEqual({});
  });

  test("cursors survive a round trip", () => {
    const state = createDefaultMetadataState();
    state.syncCursors.issues = {
      lastPassStartedAt: "2026-09-20T10:00:00.000Z",
      lastFullPassStartedAt: "2026-09-18T10:00:00.000Z",
    };
    state.syncCursors.pullRequests = {
      lastPassStartedAt: "2026-09-20T11:00:00.000Z",
      lastFullPassStartedAt: "2026-09-20T11:00:00.000Z",
    };
    const reparsed = parseRepositoryMetadataState(serializeRepositoryMetadataState(state));
    expect(reparsed.syncCursors).toEqual(state.syncCursors);
  });

  test("malformed cursors are dropped instead of failing the row", () => {
    const raw = {
      components: {},
      syncCursors: {
        issues: { lastPassStartedAt: "yesterday", lastFullPassStartedAt: "2026-09-18T10:00:00.000Z" },
        pullRequests: { lastPassStartedAt: "2026-09-20T11:00:00.000Z" },
      },
    };
    expect(parseRepositoryMetadataState(raw).syncCursors).toEqual({});
    expect(parseRepositoryMetadataState({ syncCursors: "nope" }).syncCursors).toEqual({});
    expect(parseRepositoryMetadataState({ syncCursors: { issues: 42 } }).syncCursors).toEqual({});
  });
});

describe("planMetadataPass", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");

  test("no cursor means a full pass", () => {
    const plan = planMetadataPass(undefined, now);
    expect(plan.mode).toBe("full");
  });

  test("a recent cursor gives an incremental pass with the safety margin", () => {
    const lastPass = new Date(now.getTime() - 2 * HOUR);
    const plan = planMetadataPass(
      {
        lastPassStartedAt: lastPass.toISOString(),
        lastFullPassStartedAt: new Date(now.getTime() - 3 * DAY).toISOString(),
      },
      now
    );
    expect(plan).toEqual({
      mode: "incremental",
      since: new Date(lastPass.getTime() - INCREMENTAL_SYNC_SAFETY_MARGIN_MS).toISOString(),
    });
    expect(INCREMENTAL_SYNC_SAFETY_MARGIN_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  test("a full pass older than the interval forces a full pass", () => {
    const plan = planMetadataPass(
      {
        lastPassStartedAt: new Date(now.getTime() - HOUR).toISOString(),
        lastFullPassStartedAt: new Date(now.getTime() - FULL_METADATA_PASS_INTERVAL_MS).toISOString(),
      },
      now
    );
    expect(plan.mode).toBe("full");
    expect(FULL_METADATA_PASS_INTERVAL_MS).toBe(7 * DAY);
  });

  test("a full pass just inside the interval stays incremental", () => {
    const plan = planMetadataPass(
      {
        lastPassStartedAt: new Date(now.getTime() - HOUR).toISOString(),
        lastFullPassStartedAt: new Date(now.getTime() - FULL_METADATA_PASS_INTERVAL_MS + HOUR).toISOString(),
      },
      now
    );
    expect(plan.mode).toBe("incremental");
  });

  test("a watermark in the future is not trusted", () => {
    const plan = planMetadataPass(
      {
        lastPassStartedAt: new Date(now.getTime() + DAY).toISOString(),
        lastFullPassStartedAt: now.toISOString(),
      },
      now
    );
    expect(plan.mode).toBe("full");
  });
});

describe("advanceMetadataSyncCursor", () => {
  const started = new Date("2026-09-23T12:00:00.000Z");

  test("a full pass moves both timestamps", () => {
    expect(advanceMetadataSyncCursor(undefined, "full", started)).toEqual({
      lastPassStartedAt: started.toISOString(),
      lastFullPassStartedAt: started.toISOString(),
    });
  });

  test("an incremental pass keeps the last full pass time", () => {
    const previous = {
      lastPassStartedAt: "2026-09-23T06:00:00.000Z",
      lastFullPassStartedAt: "2026-09-20T06:00:00.000Z",
    };
    expect(advanceMetadataSyncCursor(previous, "incremental", started)).toEqual({
      lastPassStartedAt: started.toISOString(),
      lastFullPassStartedAt: "2026-09-20T06:00:00.000Z",
    });
  });
});

describe("unfinished pass progress (#449 follow-up)", () => {
  const now = new Date("2026-09-25T12:00:00.000Z");

  test("numbers collapse into ranges and can be looked up", () => {
    const ranges = toNumberRanges([5, 1, 2, 3, 3, 9, 10, 7]);
    expect(ranges).toEqual([[1, 3], [5, 5], [7, 7], [9, 10]]);
    expect(numberInRanges(2, ranges)).toBe(true);
    expect(numberInRanges(8, ranges)).toBe(false);
    expect(toNumberRanges([])).toEqual([]);
  });

  test("progress survives a round trip and bad entries are dropped", () => {
    const state = createDefaultMetadataState();
    state.passProgress.issues = {
      mode: "full",
      startedAt: "2026-09-25T10:00:00.000Z",
      done: [[1, 164]],
    };
    const reparsed = parseRepositoryMetadataState(serializeRepositoryMetadataState(state));
    expect(reparsed.passProgress).toEqual(state.passProgress);

    const junk = parseRepositoryMetadataState({
      passProgress: {
        issues: { mode: "sideways", startedAt: "2026-09-25T10:00:00.000Z", done: [] },
        pullRequests: { mode: "incremental", startedAt: "2026-09-25T10:00:00.000Z", done: [] },
      },
    });
    // Unknown mode, and an incremental pass without its since.
    expect(junk.passProgress).toEqual({});
    expect(parseRepositoryMetadataState(null).passProgress).toEqual({});
  });

  test("a stored pass is resumed with its mode, since and start", () => {
    const cursor = {
      lastPassStartedAt: "2026-09-25T09:00:00.000Z",
      lastFullPassStartedAt: "2026-09-20T09:00:00.000Z",
    };
    const incremental = planMetadataPassWithProgress(
      cursor,
      { mode: "incremental", since: "2026-09-25T08:50:00.000Z", startedAt: "2026-09-25T10:00:00.000Z", done: [] },
      now
    );
    expect(incremental.plan).toEqual({ mode: "incremental", since: "2026-09-25T08:50:00.000Z" });
    expect(incremental.startedAt.toISOString()).toBe("2026-09-25T10:00:00.000Z");
    expect(incremental.resume).toBeDefined();

    const full = planMetadataPassWithProgress(
      undefined,
      { mode: "full", startedAt: "2026-09-25T10:00:00.000Z", done: [[1, 10]] },
      now
    );
    expect(full.plan.mode).toBe("full");

    const none = planMetadataPassWithProgress(cursor, undefined, now);
    expect(none.plan.mode).toBe("incremental");
    expect(none.resume).toBeUndefined();
    expect(none.startedAt).toEqual(now);
  });

  test("progress stamped in the future is ignored", () => {
    const planned = planMetadataPassWithProgress(
      undefined,
      { mode: "full", startedAt: "2026-10-25T10:00:00.000Z", done: [[1, 10]] },
      now
    );
    expect(planned.resume).toBeUndefined();
  });

  test("items are classified by what the pass already knows about them", () => {
    const cursor = {
      lastPassStartedAt: "2026-09-25T09:00:00.000Z",
      lastFullPassStartedAt: "2026-09-17T09:00:00.000Z",
    };
    const fullPlan = { mode: "full" as const, reason: "test" };
    const resume = { mode: "full" as const, startedAt: "2026-09-25T10:00:00.000Z", done: [[1, 5]] as Array<[number, number]> };
    const base = { plan: fullPlan, cursor, resume, existsInDestination: true };

    expect(classifyPassItem({ ...base, number: 3, updatedAt: "2026-09-24T00:00:00Z" })).toBe("skip");
    // Changed after the interrupted pass started: done does not count.
    expect(classifyPassItem({ ...base, number: 3, updatedAt: "2026-09-25T11:00:00Z" })).toBe("sync");
    // Not done yet, but unchanged since the last completed pass.
    expect(classifyPassItem({ ...base, number: 8, updatedAt: "2026-09-24T00:00:00Z" })).toBe("unchanged");
    // Inside the safety margin of the last pass.
    expect(
      classifyPassItem({ ...base, number: 8, updatedAt: new Date(Date.parse(cursor.lastPassStartedAt) - INCREMENTAL_SYNC_SAFETY_MARGIN_MS + 1000).toISOString() })
    ).toBe("sync");
    // Missing in the destination, no watermark, or no updated_at: full treatment.
    expect(classifyPassItem({ ...base, number: 8, updatedAt: "2026-09-24T00:00:00Z", existsInDestination: false })).toBe("sync");
    expect(classifyPassItem({ ...base, number: 8, updatedAt: "2026-09-24T00:00:00Z", cursor: undefined })).toBe("sync");
    expect(classifyPassItem({ ...base, number: 8, updatedAt: null })).toBe("sync");
    // An incremental pass never skips on the watermark alone.
    expect(
      classifyPassItem({ ...base, plan: { mode: "incremental", since: "x" }, resume: undefined, number: 8, updatedAt: "2026-09-24T00:00:00Z" })
    ).toBe("sync");
  });

  test("progress keeps what an earlier attempt of the same pass finished", () => {
    const earlier = { mode: "full" as const, startedAt: "2026-09-25T10:00:00.000Z", done: [[1, 3]] as Array<[number, number]> };
    const progress = buildPassProgress(
      { mode: "full", reason: "resume" },
      new Date(earlier.startedAt),
      [4, 5, 7],
      earlier
    );
    expect(progress).toEqual({ mode: "full", startedAt: earlier.startedAt, done: [[1, 5], [7, 7]] });

    const incremental = buildPassProgress(
      { mode: "incremental", since: "2026-09-25T08:50:00.000Z" },
      new Date("2026-09-25T10:00:00.000Z"),
      [2],
      undefined
    );
    expect(incremental.since).toBe("2026-09-25T08:50:00.000Z");
  });
});
