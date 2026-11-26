/**
 * The Repositories page status filter holds several statuses (#580). It is
 * kept as one comma separated string in the filter and the `status` URL
 * parameter, so a link with a single status, as before, still works.
 */

import type { RepoStatus } from "@/types/Repository";

/** Every repository status, in the order the filter lists them: the usual life of a mirror first. */
export const REPOSITORY_STATUSES: readonly RepoStatus[] = [
  "imported",
  "mirroring",
  "mirrored",
  "syncing",
  "synced",
  "failed",
  "pending-approval",
  "skipped",
  "ignored",
  "archived",
  "deleting",
  "deleted",
];

const KNOWN = new Set<string>(REPOSITORY_STATUSES);

/** The statuses in a filter value, known ones only, once each, in the list's order. */
export function parseStatusFilter(value: string | null | undefined): RepoStatus[] {
  const wanted = new Set(
    (value ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => KNOWN.has(part))
  );
  return REPOSITORY_STATUSES.filter((status) => wanted.has(status));
}

/** The filter value for a set of statuses; empty means no filter. */
export function formatStatusFilter(statuses: Iterable<string>): string {
  return parseStatusFilter([...statuses].join(",")).join(",");
}

export function statusLabel(status: string): string {
  const words = status.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the filter's button says. None or every status selected shows everything. */
export function statusFilterSummary(value: string | null | undefined): string {
  const selected = parseStatusFilter(value);
  const total = REPOSITORY_STATUSES.length;
  if (selected.length === 0 || selected.length === total) return "All statuses";
  if (selected.length === 1) return statusLabel(selected[0]);
  if (selected.length === total - 1) {
    const missing = REPOSITORY_STATUSES.find((status) => !selected.includes(status))!;
    return `All but ${statusLabel(missing)}`;
  }
  return `${selected.length} statuses`;
}

/** Whether the filter hides anything: picking every status is the same as picking none. */
export function isStatusFilterActive(value: string | null | undefined): boolean {
  const count = parseStatusFilter(value).length;
  return count > 0 && count < REPOSITORY_STATUSES.length;
}

/** Whether a repository with this status passes the filter. */
export function matchesStatusFilter(status: string, selected: readonly string[]): boolean {
  return selected.length === 0 || selected.includes(status);
}

/** Repositories per status, for the counts in the filter's list. */
export function countStatuses(repositories: readonly { status: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { status } of repositories) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}
