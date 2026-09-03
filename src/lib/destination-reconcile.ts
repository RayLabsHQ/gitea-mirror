/**
 * Pure decision logic for reconciling the destination (Gitea or Forgejo)
 * with the repositories table.
 *
 * The database is the only thing the cleanup service and the UI look at, so
 * a mirror that exists on the destination without a row is invisible to
 * every maintenance feature (issue #284). The helpers here take what the
 * destination reports and what the database holds and sort it into four
 * groups: mirrors the database does not know about, rows whose mirror is
 * gone, rows whose mirror moved to another owner (issue #400), and
 * everything that matches. They never touch the network or the
 * database, so they are unit tested directly; the async orchestration lives
 * in destination-reconcile-service.ts.
 */

import { sourceHostOf } from "@/lib/source-providers/kinds";
import {
  isRepositoryOnConfiguredDestination,
  type RepositoryDestination,
  type RepositoryDestinationFields,
} from "@/lib/destination-kinds";

/** What the destination reports about one repository. */
export interface DestinationRepo {
  /** Owner login on the destination. */
  owner: string;
  name: string;
  /** `owner/name` on the destination. */
  fullName: string;
  mirror: boolean;
  /** The clone address the mirror was created from, credentials stripped. */
  originalUrl: string;
  isPrivate: boolean;
  isArchived: boolean;
  description: string | null;
  defaultBranch: string;
  /** Size in kilobytes, as Gitea reports it. */
  size: number;
  htmlUrl: string;
  cloneUrl: string;
  language: string | null;
  hasIssues: boolean;
  updatedAt: string | null;
  mirrorUpdated: string | null;
}

/** The columns of a repositories row the classification needs. */
export interface TrackedRepositoryRow {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  mirroredLocation: string | null;
  status: string;
  destinationProvider?: RepositoryDestinationFields["destinationProvider"];
  destinationUrl?: RepositoryDestinationFields["destinationUrl"];
}

/**
 * Split rows into the ones whose recorded destination is the configured
 * one (or unknown) and the ones mirrored to another host. Only the first
 * group can be missing from this destination; the second group is expected
 * to be absent and must not be reset.
 */
export function splitRowsByDestination<T extends TrackedRepositoryRow>(
  rows: T[],
  destination: RepositoryDestination
): { here: T[]; elsewhere: T[] } {
  const here: T[] = [];
  const elsewhere: T[] = [];
  for (const row of rows) {
    const fields = {
      destinationProvider: row.destinationProvider ?? null,
      destinationUrl: row.destinationUrl ?? null,
    };
    (isRepositoryOnConfiguredDestination(fields, destination) ? here : elsewhere).push(row);
  }
  return { here, elsewhere };
}

export interface NotManagedRepo {
  location: string;
  reason: string;
}

export interface ClassifiedDestination {
  /** Mirrors of the configured source with no database row. */
  untracked: DestinationRepo[];
  /** Repositories on the destination this app does not own. Never touched. */
  notManaged: NotManagedRepo[];
  /** Lower-cased `owner/name` of every destination repository that matched a row. */
  trackedLocations: Set<string>;
  /** Rows the destination listing accounted for. */
  matchedRowIds: Set<string>;
  /** Rows that claim to be mirrored but no destination repository matched. */
  unmatchedMirroredRows: TrackedRepositoryRow[];
  /**
   * Rows whose recorded location is gone from the destination while a mirror
   * of the same source sits somewhere else: someone transferred it there
   * (issue #400). Sync only looks at the recorded and the expected location,
   * so until the row is repointed every run fails and a retry would create a
   * second copy at the old place.
   */
  moved: MovedMirror[];
}

export interface MovedMirror {
  row: TrackedRepositoryRow;
  /** `owner/name` where the destination has the mirror now. */
  location: string;
}

/** Statuses that mean "the mirror is supposed to exist on the destination". */
export const MIRRORED_STATUSES: ReadonlySet<string> = new Set(["mirrored", "synced"]);

export interface ParsedRepoUrl {
  /** Lower-cased host. */
  host: string;
  /** `owner/name` (or `group/sub/name`), without a `.git` suffix. */
  path: string;
  owner: string;
  name: string;
}

/**
 * Split a clone or web URL into host and repository path. Accepts https,
 * http, ssh:// and the `git@host:owner/name.git` form, and drops any
 * credentials, query and fragment. Returns null when the URL does not name
 * a repository.
 */
export function parseRepoUrl(raw: string | null | undefined): ParsedRepoUrl | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  let host = "";
  let pathname = "";

  const scp = value.match(/^(?:[^@\s/]+@)([^:/\s]+):(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    host = scp[1].toLowerCase();
    pathname = scp[2];
  } else {
    try {
      const url = new URL(value);
      host = url.host.toLowerCase();
      pathname = url.pathname;
    } catch {
      return null;
    }
  }

  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) return null;

  const last = segments[segments.length - 1].replace(/\.git$/i, "");
  if (!last) return null;
  const owner = segments.slice(0, -1).join("/");
  return { host, path: `${owner}/${last}`, owner, name: last };
}

/**
 * Hosts a mirror's original URL may point at and still count as ours: the
 * configured source, the API host it is reached through (GitHub Enterprise
 * serves clones and the API from one host, github.com from api.github.com),
 * and the host of every clone URL already stored, which covers setups where
 * the clone host differs from the nominal source.
 */
export function knownSourceHosts({
  sourceUrl,
  apiUrl,
  cloneUrls,
}: {
  sourceUrl: string;
  apiUrl?: string | null;
  cloneUrls: Iterable<string | null | undefined>;
}): Set<string> {
  const hosts = new Set<string>();
  const add = (host: string | null | undefined) => {
    const value = (host ?? "").trim().toLowerCase();
    if (value) hosts.add(value);
  };

  add(sourceHostOf(sourceUrl));

  if (apiUrl) {
    const apiHost = sourceHostOf(apiUrl);
    add(apiHost);
    if (apiHost.startsWith("api.")) add(apiHost.slice(4));
  }

  for (const cloneUrl of cloneUrls) {
    add(parseRepoUrl(cloneUrl)?.host);
  }

  return hosts;
}

function cloneKey(url: string | null | undefined): string | null {
  const parsed = parseRepoUrl(url);
  return parsed ? `${parsed.host}/${parsed.path.toLowerCase()}` : null;
}

/**
 * Sort the destination listing against the database rows.
 *
 * A destination repository is ours when it is a mirror and its original URL
 * points at a known source host. It is tracked when a row records it as the
 * mirrored location, stores the same clone URL, or carries the same source
 * path as its full name. Anything else that is ours is untracked. Native
 * repositories and mirrors of other hosts are reported, never touched.
 */
export function classifyDestinationRepos({
  destinationRepos,
  rows,
  knownHosts,
}: {
  destinationRepos: DestinationRepo[];
  rows: TrackedRepositoryRow[];
  knownHosts: Set<string>;
}): ClassifiedDestination {
  const byLocation = new Map<string, TrackedRepositoryRow>();
  const byCloneKey = new Map<string, TrackedRepositoryRow>();
  const byFullName = new Map<string, TrackedRepositoryRow>();

  for (const row of rows) {
    const location = (row.mirroredLocation ?? "").trim().toLowerCase();
    if (location && !byLocation.has(location)) byLocation.set(location, row);
    const key = cloneKey(row.cloneUrl);
    if (key && !byCloneKey.has(key)) byCloneKey.set(key, row);
    const fullName = row.fullName.trim().toLowerCase();
    if (fullName && !byFullName.has(fullName)) byFullName.set(fullName, row);
  }

  // Every mirror the listing showed, so a source match at a new location can
  // be told apart from a second copy whose original is still in place.
  const listedMirrorLocations = new Set(
    destinationRepos.filter((repo) => repo.mirror).map((repo) => repo.fullName.toLowerCase())
  );

  const untracked: DestinationRepo[] = [];
  const notManaged: NotManagedRepo[] = [];
  const trackedLocations = new Set<string>();
  const matchedRowIds = new Set<string>();
  const moved: MovedMirror[] = [];
  const movedRowIds = new Set<string>();

  for (const repo of destinationRepos) {
    const location = repo.fullName.toLowerCase();

    if (!repo.mirror) {
      notManaged.push({ location: repo.fullName, reason: "not a mirror" });
      continue;
    }

    const origin = parseRepoUrl(repo.originalUrl);
    if (!origin) {
      notManaged.push({ location: repo.fullName, reason: "mirror without a source URL" });
      continue;
    }

    if (!knownHosts.has(origin.host)) {
      notManaged.push({ location: repo.fullName, reason: `mirror of ${origin.host}` });
      continue;
    }

    const atRecordedLocation = byLocation.get(location);
    const row =
      atRecordedLocation ??
      byCloneKey.get(`${origin.host}/${origin.path.toLowerCase()}`) ??
      byFullName.get(origin.path.toLowerCase());

    if (!row) {
      untracked.push(repo);
      continue;
    }

    // Matched by source rather than by the recorded location. That is a move
    // only when the recorded mirror is really gone; if it is still listed,
    // this repository is a second copy and is left alone.
    const recorded = (row.mirroredLocation ?? "").trim();
    if (!atRecordedLocation && recorded && recorded.toLowerCase() !== location) {
      const originalStillThere = listedMirrorLocations.has(recorded.toLowerCase());
      if (originalStillThere || movedRowIds.has(row.id)) {
        const original = originalStillThere ? recorded : moved.find((m) => m.row.id === row.id)?.location;
        notManaged.push({ location: repo.fullName, reason: `second copy of ${original ?? recorded}` });
        continue;
      }
      moved.push({ row, location: repo.fullName });
      movedRowIds.add(row.id);
    }

    trackedLocations.add(location);
    matchedRowIds.add(row.id);
  }

  const unmatchedMirroredRows = rows.filter(
    (row) => MIRRORED_STATUSES.has(row.status) && !matchedRowIds.has(row.id)
  );

  return { untracked, notManaged, trackedLocations, matchedRowIds, unmatchedMirroredRows, moved };
}

/**
 * The `owner/name` a row's mirror should live at, from the recorded location
 * when there is one, otherwise from the owner the strategy resolves.
 */
export function expectedLocation(
  row: Pick<TrackedRepositoryRow, "name" | "mirroredLocation">,
  resolvedOwner: string
): { owner: string; name: string; location: string } {
  const recorded = (row.mirroredLocation ?? "").trim();
  if (recorded.includes("/")) {
    const slash = recorded.indexOf("/");
    const owner = recorded.slice(0, slash).trim();
    const name = recorded.slice(slash + 1).trim();
    if (owner && name) return { owner, name, location: `${owner}/${name}` };
  }
  const owner = resolvedOwner.trim();
  return { owner, name: row.name, location: `${owner}/${row.name}` };
}

/**
 * Destination owners worth listing: the configured accounts and every owner
 * the database already points at. Deduplicated without regard to case,
 * keeping the first spelling seen.
 */
export function collectDestinationOwners(candidates: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const owners: string[] = [];
  for (const candidate of candidates) {
    const value = (candidate ?? "").trim();
    if (!value || value.includes("/")) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(value);
  }
  return owners;
}
