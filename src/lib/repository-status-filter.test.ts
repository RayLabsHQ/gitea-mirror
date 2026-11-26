import { describe, expect, test } from "bun:test";
import { repoStatusEnum } from "@/types/Repository";
import {
  REPOSITORY_STATUSES,
  countStatuses,
  isStatusFilterActive,
  formatStatusFilter,
  matchesStatusFilter,
  parseStatusFilter,
  statusFilterSummary,
  statusLabel,
} from "./repository-status-filter";

test("the filter lists every repository status once", () => {
  expect([...REPOSITORY_STATUSES].sort()).toEqual([...repoStatusEnum.options].sort());
});

describe("parseStatusFilter", () => {
  test("reads a single status, as links before #580 had it", () => {
    expect(parseStatusFilter("failed")).toEqual(["failed"]);
  });

  test("reads several, in the list's order, once each, ignoring case and spaces", () => {
    expect(parseStatusFilter(" Synced,mirrored, syncing,mirrored ")).toEqual(["mirrored", "syncing", "synced"]);
    expect(parseStatusFilter("failed,imported")).toEqual(["imported", "failed"]);
  });

  test("drops unknown values and empties", () => {
    expect(parseStatusFilter("warning,,nope,imported")).toEqual(["imported"]);
    expect(parseStatusFilter("")).toEqual([]);
    expect(parseStatusFilter(undefined)).toEqual([]);
  });
});

describe("formatStatusFilter", () => {
  test("writes known statuses in order", () => {
    expect(formatStatusFilter(new Set(["synced", "mirrored", "bogus"]))).toBe("mirrored,synced");
    expect(formatStatusFilter([])).toBe("");
  });
});

describe("statusFilterSummary", () => {
  test("none and every status both read as All statuses", () => {
    expect(statusFilterSummary("")).toBe("All statuses");
    expect(statusFilterSummary(REPOSITORY_STATUSES.join(","))).toBe("All statuses");
  });

  test("one status by name, all but one by the one left out, otherwise a count", () => {
    expect(statusFilterSummary("pending-approval")).toBe("Pending approval");
    expect(statusFilterSummary(REPOSITORY_STATUSES.filter((s) => s !== "imported").join(","))).toBe(
      "All but Imported"
    );
    expect(statusFilterSummary("mirrored,synced,syncing")).toBe("3 statuses");
  });
});

test("isStatusFilterActive: none and all hide nothing", () => {
  expect(isStatusFilterActive("")).toBe(false);
  expect(isStatusFilterActive(REPOSITORY_STATUSES.join(","))).toBe(false);
  expect(isStatusFilterActive("failed")).toBe(true);
});

describe("matchesStatusFilter", () => {
  test("an empty selection lets everything through", () => {
    expect(matchesStatusFilter("failed", [])).toBe(true);
    expect(matchesStatusFilter("failed", ["mirrored", "synced"])).toBe(false);
    expect(matchesStatusFilter("synced", ["mirrored", "synced"])).toBe(true);
  });
});

test("statusLabel", () => {
  expect(statusLabel("pending-approval")).toBe("Pending approval");
  expect(statusLabel("synced")).toBe("Synced");
});

test("countStatuses", () => {
  expect(countStatuses([{ status: "synced" }, { status: "failed" }, { status: "synced" }])).toEqual({ synced: 2, failed: 1 });
  expect(countStatuses([])).toEqual({});
});
