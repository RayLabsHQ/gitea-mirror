import { describe, expect, test } from "bun:test";
import { countLatestStatuses, latestStatusBySubject } from "./activity-status";

const at = (iso: string) => new Date(iso);

describe("Activity Log status chips (#454)", () => {
  test("a start and finish in the same second count as finished, in either order", () => {
    const start = { repositoryId: "r1", status: "syncing", timestamp: at("2026-09-26T00:29:48.000Z") };
    const finish = { repositoryId: "r1", status: "synced", timestamp: at("2026-09-26T00:29:48.000Z") };
    const aggregate = { status: "mirrored", timestamp: at("2026-09-26T00:29:48.000Z") };

    // The order the reporter's export came back in.
    expect(countLatestStatuses([aggregate, start, finish])).toEqual(new Map([["synced", 1]]));
    expect(countLatestStatuses([finish, start])).toEqual(new Map([["synced", 1]]));
  });

  test("a sync that is really still running stays syncing", () => {
    const earlier = { repositoryId: "r1", status: "synced", timestamp: at("2026-09-26T00:00:00.000Z") };
    const running = { repositoryId: "r1", status: "syncing", timestamp: at("2026-09-26T01:00:00.000Z") };
    expect(latestStatusBySubject([running, earlier]).get("r1")).toBe("syncing");
  });

  test("the newest event decides otherwise, and events without a subject are ignored", () => {
    const counts = countLatestStatuses([
      { repositoryId: "r1", status: "synced", timestamp: "2026-09-26T02:00:00Z" },
      { repositoryId: "r1", status: "failed", timestamp: "2026-09-26T01:00:00Z" },
      { organizationId: "o1", status: "failed", timestamp: "2026-09-26T01:00:00Z" },
      { status: "mirrored", timestamp: "2026-09-26T01:00:00Z" },
    ]);
    expect(counts).toEqual(new Map([["synced", 1], ["failed", 1]]));
  });

  test("a newer start never loses to an older finish from another second", () => {
    const counts = countLatestStatuses([
      { repositoryName: "a", status: "mirroring", timestamp: "2026-09-26T00:00:02Z" },
      { repositoryName: "a", status: "mirrored", timestamp: "2026-09-26T00:00:01Z" },
    ]);
    expect(counts).toEqual(new Map([["mirroring", 1]]));
  });
});
