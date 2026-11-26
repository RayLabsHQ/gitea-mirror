/**
 * Moving existing mirrors to where the current settings put them (#550).
 *
 * Changing the mirror strategy, an organization's destination or a starred
 * setting only affects new mirrors: sync follows each mirror's recorded
 * location, so existing mirrors stay where they were created. This module
 * decides which mirrors are out of place and holds the types the preview
 * and the run share with the UI. mirror-placement-service.ts does the
 * database reads and the destination checks.
 *
 * Pure, and free of server imports, so the client can use the types.
 */

import type { Repository } from "@/lib/db/schema";
import { splitLocation } from "@/lib/destination-transfer";

/** Which setting decided a mirror's place, shown next to the target. */
export type PlacementVia = "strategy" | "organization" | "repository" | "starred";

export interface PlacementTarget {
  owner: string;
  via: PlacementVia;
}

/** A mirror whose recorded owner is not the one the settings name. */
export interface PlacementCandidate {
  id: string;
  fullName: string;
  /** The source repository's name, which a new mirror would get. */
  sourceName: string;
  cloneUrl: string | null;
  from: { owner: string; name: string };
  target: PlacementTarget;
}

export interface PlacementSkip {
  id: string;
  fullName: string;
  from: string;
  reason: string;
}

export interface PlacementScan {
  candidates: PlacementCandidate[];
  skipped: PlacementSkip[];
  inPlace: number;
}

const BUSY_STATUSES = new Set(["mirroring", "syncing", "deleting"]);

export interface PlacementScanRow {
  row: Pick<Repository, "id" | "fullName" | "name" | "cloneUrl" | "mirroredLocation" | "status"> & {
    /** Set while cleanup waits on a source that disappeared (#549). */
    sourceMissingSince?: Date | number | null;
  };
  /** Where the settings put the row, or null when it could not be worked out. */
  target: PlacementTarget | null;
  /** False when the row was mirrored to another destination than the configured one. */
  onConfiguredDestination: boolean;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Sort the user's rows into mirrors to look at, mirrors to leave out and
 * a count of mirrors already in place. Only the owner decides: a mirror
 * under the right owner is in place whatever its name, so a name given to
 * avoid a clash, or by hand, is never touched on its own. Rows never
 * mirrored, and rows the user ignores, are left out silently: the next
 * mirror run puts them in the right place, or nowhere.
 */
export function scanPlacement(rows: PlacementScanRow[]): PlacementScan {
  const candidates: PlacementCandidate[] = [];
  const skipped: PlacementSkip[] = [];
  let inPlace = 0;

  for (const { row, target, onConfiguredDestination } of rows) {
    const from = splitLocation(row.mirroredLocation);
    if (!from || row.status === "ignored") continue;
    const skip = (reason: string) =>
      skipped.push({ id: row.id ?? "", fullName: row.fullName, from: `${from.owner}/${from.name}`, reason });

    if (row.status === "archived" || from.name.toLowerCase().startsWith("archived-")) {
      skip("archived after its source disappeared");
      continue;
    }
    if (row.sourceMissingSince) {
      skip("its source is gone and cleanup is waiting to act");
      continue;
    }
    if (BUSY_STATUSES.has(row.status)) {
      skip(`a ${row.status === "deleting" ? "delete" : row.status === "syncing" ? "sync" : "mirror run"} is in progress`);
      continue;
    }
    if (!onConfiguredDestination) {
      skip("mirrored to a different destination");
      continue;
    }
    const owner = target?.owner.trim() ?? "";
    if (!target || !owner) {
      skip("no destination could be worked out from the settings");
      continue;
    }
    if (sameName(from.owner, owner)) {
      inPlace++;
      continue;
    }
    candidates.push({
      id: row.id ?? "",
      fullName: row.fullName,
      sourceName: row.name,
      cloneUrl: row.cloneUrl ?? null,
      from,
      target: { owner, via: target.via },
    });
  }

  candidates.sort(
    (a, b) => a.target.owner.localeCompare(b.target.owner) || a.fullName.localeCompare(b.fullName)
  );
  skipped.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { candidates, skipped, inPlace };
}

/** How the owner a move goes to stands on the destination. */
export type TargetOwnerState =
  /** The account the token belongs to. */
  | "account"
  /** An organization the token can create repositories in. */
  | "organization"
  /** Free: the move creates the organization. */
  | "new-organization";

/** A move the preview found possible. */
export interface PlannedMove {
  id: string;
  fullName: string;
  /** Where the mirror is now (found on the destination, so it can differ from the record). */
  from: string;
  /** owner/name it ends at. */
  to: string;
  via: PlacementVia;
  /** "record": the mirror is already at `to` or a copy of the same source is; only the record changes. */
  kind: "move" | "record";
  ownerState: TargetOwnerState;
  renamed: boolean;
  /** Why the mirror keeps its current name although renaming is on. */
  keptNameBecause?: string;
  /** For a rename, whether it is renamed after the transfer (the usual case) or before. */
  order: "transfer-first" | "rename-first";
  /** Something worth knowing, such as the recorded location being stale. */
  note?: string;
}

/** A mirror the preview cannot move, with what to do about it. */
export interface BlockedMove {
  id: string;
  fullName: string;
  from: string;
  to: string;
  via: PlacementVia;
  reason: string;
  hint?: string;
}

export interface PlacementPreview {
  rename: boolean;
  moves: PlannedMove[];
  blocked: BlockedMove[];
  skipped: PlacementSkip[];
  inPlace: number;
}

/** What the footer shows without asking the destination anything. */
export interface PlacementSummary {
  supported: boolean;
  /** Mirrors whose recorded owner differs from the settings. */
  outOfPlace: number;
  /** Mirrors already under the owner the settings name. */
  inPlace: number;
}

/**
 * Names the destination keeps for itself and refuses for a new
 * organization, as Gitea 1.24.7 and Forgejo 17 answer them (422 "name is
 * reserved" or "name pattern is not allowed"). Checked in the preview so a
 * move that would fail is shown as blocked; the run still reports anything
 * else the destination refuses.
 */
const RESERVED_OWNER_NAMES = new Set([
  "api", "assets", "attachments", "avatar", "avatars", "captcha", "explore", "favicon.ico", "ghost",
  "gitea-actions", "issues", "login", "manifest.json", "metrics", "milestones", "notifications", "org",
  "pulls", "repo", "repo-avatars", "robots.txt", "sitemap.xml", "ssh_info", "swagger.v1.json", "user", "v2",
]);
/** Forgejo also refuses these; Gitea allows them. */
const FORGEJO_RESERVED_OWNER_NAMES = new Set(["admin", "forgejo-actions"]);
const RESERVED_OWNER_SUFFIXES = [".keys", ".gpg", ".rss", ".atom", ".png"];

export function isReservedOwnerName(name: string, provider?: string): boolean {
  const lower = name.toLowerCase();
  return (
    RESERVED_OWNER_NAMES.has(lower) ||
    (provider === "forgejo" && FORGEJO_RESERVED_OWNER_NAMES.has(lower)) ||
    RESERVED_OWNER_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

/** What the Configuration page knows when it decides on its bar. */
export interface PlacementBarState {
  /** The destination supports moving mirrors. */
  supported: boolean;
  outOfPlace: number;
  /** The placement settings as the page opened, once saved; null before the first summary. */
  baseKey: string | null;
  /** The settings the latest summary was read for. */
  summaryKey: string | null;
  /** The settings now. */
  currentKey: string;
  /** The settings the bar was last put away for. */
  dismissedKey: string | null;
  /** A move was started from this page and its result has not been put away. */
  runStartedHere: boolean;
}

/**
 * What the bar at the bottom of the Configuration page shows: "run" for a
 * move started there, "prompt" when a change made on the page left mirrors
 * out of place, and nothing otherwise. Mirrors that were already out of
 * place when the page opened are left to the Organization Structure card,
 * and a prompt waits for the summary of the current settings, so it never
 * shows a count that belongs to the previous ones.
 */
export function placementBarMode(state: PlacementBarState): "prompt" | "run" | null {
  if (state.runStartedHere) return "run";
  const prompt =
    state.supported &&
    state.outOfPlace > 0 &&
    state.baseKey !== null &&
    state.summaryKey === state.currentKey &&
    state.currentKey !== state.baseKey &&
    state.currentKey !== state.dismissedKey;
  return prompt ? "prompt" : null;
}
