/**
 * Moving a mirror to another owner on the destination (issue #400).
 *
 * Changing a repository's destination used to change a label and nothing
 * else: the mirror stayed where it was, and the next mirror run created a
 * second copy. These helpers decide what a move means for a row and for an
 * organization; destination-transfer-service.ts does the talking to the
 * destination and the database writes.
 */

import type { Repository } from "@/lib/db/schema";
import type { GiteaRepoInfo } from "@/lib/gitea-enhanced";
import { cloneUrlsMatch } from "@/lib/utils/mirror-source-match";

export type MoveOutcome =
  /** The destination moved the repository. */
  | "moved"
  /** The destination wants an owner of the target to accept first. */
  | "pending"
  /** A mirror of this source already sat under the target; the row now points at it. */
  | "recorded"
  /** The row has never been mirrored, so there was nothing to move. */
  | "not-mirrored";

export interface MoveResult {
  outcome: MoveOutcome;
  /** owner/name the row pointed at before, empty for a row that was never mirrored. */
  from: string;
  /** owner/name the row points at now, or the target of a pending transfer. */
  to: string;
  message: string;
}

export type MoveErrorCode =
  | "destination-unsupported"
  | "destination-mismatch"
  | "not-on-destination"
  | "name-taken"
  | "transfer-pending"
  | "forbidden"
  | "destination-error";

/** A move that could not be done, with the HTTP status the routes answer with. */
export class MoveMirrorError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: MoveErrorCode
  ) {
    super(message);
    this.name = "MoveMirrorError";
  }
}

/** Letters, digits, dots, dashes and underscores: what Gitea accepts for an owner name. */
export const OWNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function splitLocation(
  location: string | null | undefined
): { owner: string; name: string } | null {
  const trimmed = (location ?? "").trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

export function ownerLogin(info: GiteaRepoInfo | null | undefined): string {
  if (!info) return "";
  return typeof info.owner === "string" ? info.owner : info.owner?.login ?? "";
}

/**
 * Whether the repository at a location this app recorded itself is still
 * its mirror. Unlike isMirrorOfSource this trusts a mirror without an
 * original_url, because the location came from our own success path; a
 * mirror whose original_url names another source is not ours.
 */
export function isRecordedMirror(
  info: GiteaRepoInfo | null,
  sourceCloneUrl?: string | null
): boolean {
  if (!info || !info.mirror) return false;
  const original = typeof info.original_url === "string" ? info.original_url.trim() : "";
  if (!original) return true;
  return cloneUrlsMatch(original, sourceCloneUrl);
}

export interface MovePlanEntry {
  id: string;
  fullName: string;
  from: string;
  to: string;
}

export interface MovePlan {
  moves: MovePlanEntry[];
  skipped: Array<{ fullName: string; reason: string }>;
}

const BUSY_STATUSES = new Set(["mirroring", "syncing", "deleting"]);

type PlanRow = Pick<
  Repository,
  "id" | "fullName" | "isStarred" | "destinationOrg" | "mirroredLocation" | "status"
>;

/**
 * Which repositories of an organization move when its destination changes.
 * Rows with their own destination keep it (the per-repository override wins
 * over the organization's), starred repositories have their own placement,
 * and a row that was never mirrored has nothing to move.
 */
export function planOrganizationMove({
  rows,
  targetOwnerFor,
}: {
  rows: PlanRow[];
  targetOwnerFor: (row: PlanRow) => string;
}): MovePlan {
  const moves: MovePlanEntry[] = [];
  const skipped: MovePlan["skipped"] = [];

  for (const row of rows) {
    if (row.isStarred) {
      skipped.push({ fullName: row.fullName, reason: "starred repositories keep their own destination" });
      continue;
    }
    if ((row.destinationOrg ?? "").trim()) {
      skipped.push({ fullName: row.fullName, reason: `has its own destination (${row.destinationOrg})` });
      continue;
    }
    const from = splitLocation(row.mirroredLocation);
    if (!from) {
      skipped.push({ fullName: row.fullName, reason: "not mirrored yet" });
      continue;
    }
    if (BUSY_STATUSES.has(row.status)) {
      skipped.push({ fullName: row.fullName, reason: `a ${row.status} run is in progress` });
      continue;
    }
    const target = targetOwnerFor(row).trim();
    if (!target) {
      skipped.push({ fullName: row.fullName, reason: "no destination owner could be determined" });
      continue;
    }
    if (from.owner.toLowerCase() === target.toLowerCase()) {
      skipped.push({ fullName: row.fullName, reason: `already under ${from.owner}` });
      continue;
    }
    moves.push({
      id: row.id ?? "",
      fullName: row.fullName,
      from: `${from.owner}/${from.name}`,
      to: `${target}/${from.name}`,
    });
  }

  return { moves, skipped };
}

/** What the organization route answers; the client renders the confirmation from it. */
export interface OrganizationMoveResult {
  dryRun: boolean;
  plan: MovePlan;
  moved: Array<{ fullName: string; from: string; to: string }>;
  pending: Array<{ fullName: string; from: string; to: string }>;
  recorded: Array<{ fullName: string; from: string; to: string }>;
  failed: Array<{ fullName: string; error: string }>;
}
