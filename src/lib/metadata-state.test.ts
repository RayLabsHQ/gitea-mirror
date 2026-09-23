/**
 * Incremental metadata sync watermarks (#449): parsing, serialisation and
 * the full vs incremental decision.
 */
import { describe, expect, test } from "bun:test";
import {
  FULL_METADATA_PASS_INTERVAL_MS,
  INCREMENTAL_SYNC_SAFETY_MARGIN_MS,
  advanceMetadataSyncCursor,
  createDefaultMetadataState,
  parseRepositoryMetadataState,
  planMetadataPass,
  serializeRepositoryMetadataState,
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
