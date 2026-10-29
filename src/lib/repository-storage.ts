/**
 * Storage a mirror takes up on its destination (#479). A sync measures it from
 * responses it already fetches: the repository GET before `mirror-sync`
 * carries `size`, and the release listing the retention pass reads carries
 * every asset's size. Refresh sizes (storage-refresh.ts) reads the same fields
 * on request. Nothing here makes a request.
 */

import { isPushDestinationKind } from "./destination-kinds";

/**
 * Columns to record from a destination repository response. Gitea and Forgejo
 * report `size` in KiB, Git and LFS together. Empty when the response has no
 * usable size, so a missing field never overwrites a stored number.
 */
export function destinationSizeColumns(
  info: { size?: unknown } | null | undefined,
  now: Date = new Date()
): { destinationSize?: number; storageCheckedAt?: Date } {
  const size = info?.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return {};
  return { destinationSize: Math.round(size * 1024), storageCheckedAt: now };
}

export interface ReleaseAssetSummary {
  count: number;
  bytes: number;
}

/** Count and total size of the assets across a destination release listing. */
export function summarizeReleaseAssets(
  releases: ReadonlyArray<{ assets?: ReadonlyArray<{ size?: unknown }> | null }>
): ReleaseAssetSummary {
  let count = 0;
  let bytes = 0;
  for (const release of releases) {
    for (const asset of release.assets ?? []) {
      count += 1;
      if (typeof asset.size === "number" && Number.isFinite(asset.size) && asset.size > 0) {
        bytes += asset.size;
      }
    }
  }
  return { count, bytes };
}

/** Repository columns the storage overview reads. */
export interface StorageSourceRow {
  id: string;
  name: string;
  fullName: string;
  mirroredLocation: string | null;
  status: string;
  destinationProvider: string;
  destinationSize: number | null;
  releaseAssetsSize: number | null;
  releaseAssetsCount: number | null;
  storageCheckedAt: Date | null;
}

export interface StorageRepository {
  id: string;
  /** Source full name, as the Repositories page shows it. */
  fullName: string;
  /** owner/name on the destination; empty when not recorded. */
  location: string;
  /** Destination owner, the first half of `location`. */
  owner: string;
  destinationSize: number | null;
  releaseAssetsSize: number | null;
  releaseAssetsCount: number | null;
  total: number;
  checkedAt: string | null;
}

export interface StorageOwner {
  owner: string;
  destinationSize: number;
  releaseAssetsSize: number;
  total: number;
  repositories: number;
}

export interface StorageOverview {
  totals: {
    total: number;
    destinationSize: number;
    releaseAssetsSize: number;
    releaseAssetsCount: number;
    /** Repositories with at least one recorded number. */
    measured: number;
    /** Repositories with a mirror on a Gitea or Forgejo destination. */
    mirrored: number;
  };
  owners: StorageOwner[];
  repositories: StorageRepository[];
}

// Statuses that mean a mirror exists on the destination. A failed row may be a
// failed first mirror, so it only counts once it has been measured.
const MIRROR_EXISTS_STATUSES = new Set(["mirrored", "synced", "syncing", "archived", "pending-approval"]);

function isMeasured(row: Pick<StorageSourceRow, "destinationSize" | "releaseAssetsSize">): boolean {
  return row.destinationSize !== null || row.releaseAssetsSize !== null;
}

/**
 * True for a row with a mirror on a Gitea or Forgejo destination: the rows
 * the overview counts as mirrored and Refresh sizes measures.
 */
export function countsAsStorageMirror(
  row: Pick<StorageSourceRow, "status" | "destinationProvider" | "destinationSize" | "releaseAssetsSize">
): boolean {
  if (isPushDestinationKind(row.destinationProvider)) return false;
  return isMeasured(row) || MIRROR_EXISTS_STATUSES.has(row.status);
}

/** The storage page's numbers: totals, per destination owner, and per repository, largest first. */
export function buildStorageOverview(rows: ReadonlyArray<StorageSourceRow>): StorageOverview {
  const repositories: StorageRepository[] = [];
  const owners = new Map<string, StorageOwner>();
  let mirrored = 0;

  for (const row of rows) {
    if (!countsAsStorageMirror(row)) continue;
    mirrored += 1;
    if (!isMeasured(row)) continue;

    const location = (row.mirroredLocation ?? "").trim();
    const owner = location.includes("/") ? location.split("/")[0] : "";
    const destinationSize = row.destinationSize ?? 0;
    const releaseAssetsSize = row.releaseAssetsSize ?? 0;
    const total = destinationSize + releaseAssetsSize;

    repositories.push({
      id: row.id,
      fullName: row.fullName || row.name,
      location,
      owner,
      destinationSize: row.destinationSize,
      releaseAssetsSize: row.releaseAssetsSize,
      releaseAssetsCount: row.releaseAssetsCount,
      total,
      checkedAt: row.storageCheckedAt ? row.storageCheckedAt.toISOString() : null,
    });

    const group = owners.get(owner) ?? {
      owner,
      destinationSize: 0,
      releaseAssetsSize: 0,
      total: 0,
      repositories: 0,
    };
    group.destinationSize += destinationSize;
    group.releaseAssetsSize += releaseAssetsSize;
    group.total += total;
    group.repositories += 1;
    owners.set(owner, group);
  }

  repositories.sort((a, b) => b.total - a.total || a.fullName.localeCompare(b.fullName));
  const ownerList = [...owners.values()].sort((a, b) => b.total - a.total || a.owner.localeCompare(b.owner));

  return {
    totals: {
      total: repositories.reduce((sum, repo) => sum + repo.total, 0),
      destinationSize: repositories.reduce((sum, repo) => sum + (repo.destinationSize ?? 0), 0),
      releaseAssetsSize: repositories.reduce((sum, repo) => sum + (repo.releaseAssetsSize ?? 0), 0),
      releaseAssetsCount: repositories.reduce((sum, repo) => sum + (repo.releaseAssetsCount ?? 0), 0),
      measured: repositories.length,
      mirrored,
    },
    owners: ownerList,
    repositories,
  };
}
