import { describe, expect, test } from "bun:test";
import {
  buildStorageOverview,
  destinationSizeColumns,
  summarizeReleaseAssets,
  type StorageSourceRow,
} from "./repository-storage";

describe("destinationSizeColumns", () => {
  test("turns the KiB Gitea reports into bytes", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    expect(destinationSizeColumns({ size: 1536 }, now)).toEqual({
      destinationSize: 1536 * 1024,
      storageCheckedAt: now,
    });
  });

  test("records an empty repository as zero", () => {
    expect(destinationSizeColumns({ size: 0 }).destinationSize).toBe(0);
  });

  test("writes nothing without a usable size", () => {
    expect(destinationSizeColumns({})).toEqual({});
    expect(destinationSizeColumns(null)).toEqual({});
    expect(destinationSizeColumns({ size: "12" })).toEqual({});
    expect(destinationSizeColumns({ size: -1 })).toEqual({});
    expect(destinationSizeColumns({ size: Number.NaN })).toEqual({});
  });
});

describe("summarizeReleaseAssets", () => {
  test("counts every asset and adds up their sizes", () => {
    expect(
      summarizeReleaseAssets([
        { assets: [{ size: 100 }, { size: 50 }] },
        { assets: [] },
        { assets: null },
        {},
        { assets: [{ size: 1000 }] },
      ])
    ).toEqual({ count: 3, bytes: 1150 });
  });

  test("counts an asset without a size but adds nothing for it", () => {
    expect(summarizeReleaseAssets([{ assets: [{}, { size: "9" }, { size: 4 }] }])).toEqual({
      count: 3,
      bytes: 4,
    });
  });
});

function row(overrides: Partial<StorageSourceRow>): StorageSourceRow {
  return {
    id: "r",
    name: "repo",
    fullName: "acme/repo",
    mirroredLocation: "archive/repo",
    status: "synced",
    destinationProvider: "gitea",
    destinationSize: null,
    releaseAssetsSize: null,
    releaseAssetsCount: null,
    storageCheckedAt: null,
    ...overrides,
  };
}

describe("buildStorageOverview", () => {
  const checkedAt = new Date("2026-10-29T08:00:00Z");
  const rows = [
    row({ id: "a", fullName: "acme/app", mirroredLocation: "archive/app", destinationSize: 300, releaseAssetsSize: 700, releaseAssetsCount: 4, storageCheckedAt: checkedAt }),
    row({ id: "b", fullName: "acme/lib", mirroredLocation: "archive/lib", destinationSize: 200, storageCheckedAt: checkedAt }),
    row({ id: "c", fullName: "me/dots", mirroredLocation: "me/dots", destinationSize: 50 }),
    // Mirrored but not synced since the upgrade.
    row({ id: "d", fullName: "acme/new", status: "mirrored" }),
    // Imported only: neither measured nor mirrored.
    row({ id: "e", fullName: "acme/later", status: "imported", mirroredLocation: "" }),
    // A failed first mirror has nothing on the destination yet.
    row({ id: "f", fullName: "acme/broken", status: "failed" }),
    // Push destinations have no size API; they are left out entirely.
    row({ id: "g", fullName: "acme/pushed", destinationProvider: "github", status: "synced", destinationSize: 999 }),
  ];

  test("adds up the measured repositories", () => {
    expect(buildStorageOverview(rows).totals).toEqual({
      total: 1250,
      destinationSize: 550,
      releaseAssetsSize: 700,
      releaseAssetsCount: 4,
      measured: 3,
      mirrored: 4,
    });
  });

  test("lists measured repositories largest first", () => {
    const overview = buildStorageOverview(rows);
    expect(overview.repositories.map((repo) => [repo.id, repo.total])).toEqual([
      ["a", 1000],
      ["b", 200],
      ["c", 50],
    ]);
    expect(overview.repositories[0]).toMatchObject({
      fullName: "acme/app",
      location: "archive/app",
      owner: "archive",
      releaseAssetsCount: 4,
      checkedAt: checkedAt.toISOString(),
    });
    // An unmeasured release side stays null so the page can tell it from zero.
    expect(overview.repositories[1].releaseAssetsSize).toBeNull();
  });

  test("groups by destination owner", () => {
    expect(buildStorageOverview(rows).owners).toEqual([
      { owner: "archive", destinationSize: 500, releaseAssetsSize: 700, total: 1200, repositories: 2 },
      { owner: "me", destinationSize: 50, releaseAssetsSize: 0, total: 50, repositories: 1 },
    ]);
  });

  test("is empty before anything was measured", () => {
    const overview = buildStorageOverview([row({ status: "mirrored" })]);
    expect(overview.repositories).toEqual([]);
    expect(overview.owners).toEqual([]);
    expect(overview.totals).toMatchObject({ total: 0, measured: 0, mirrored: 1 });
  });
});
