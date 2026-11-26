/**
 * The preview of moving existing mirrors to where the current settings put
 * them (#550): reads the rows, works out each mirror's place the way a
 * mirror run does, and checks on the destination what a move would meet.
 * Nothing here changes anything.
 */

import { eq } from "drizzle-orm";
import { db, organizations, repositories, sources } from "@/lib/db";
import type { Repository } from "@/lib/db/schema";
import type { Config } from "@/types/config";
import { HttpError, httpGet, httpRequest } from "@/lib/http-client";
import { decryptConfigTokens } from "@/lib/utils/config-encryption";
import { findGiteaMirrorBySource, type GiteaRepoInfo } from "@/lib/gitea-enhanced";
import { resolveDestinationOwner } from "@/lib/gitea";
import { usesStarredDestination } from "@/lib/utils/starred-destination";
import { isMirrorOfSource } from "@/lib/utils/mirror-source-match";
import { assertRepositoryMatchesConfiguredDestination, usesPushEngine } from "@/lib/destination-connection";
import { OWNER_NAME_PATTERN, isRecordedMirror, ownerLogin, splitLocation } from "@/lib/destination-transfer";
import {
  isReservedOwnerName,
  scanPlacement,
  type BlockedMove,
  type PlacementCandidate,
  type PlacementPreview,
  type PlacementScan,
  type PlacementScanRow,
  type PlacementSummary,
  type PlacementVia,
  type PlannedMove,
  type TargetOwnerState,
} from "@/lib/mirror-placement";

const LOOKUP_CONCURRENCY = 6;

/** What a name on the destination holds. A redirect left by a rename or move counts as free. */
export type NameState = { state: "free" } | { state: "taken"; info: GiteaRepoInfo };

export type OwnerState =
  | { kind: TargetOwnerState }
  | { kind: "user" }
  | { kind: "no-access" }
  | { kind: "invalid" }
  | { kind: "reserved" }
  | { kind: "error"; message: string };

/** The destination calls the preview makes; injectable so the decisions can be tested without a server. */
export interface PlacementDeps {
  /** The token's account. */
  me(): Promise<{ login: string; isAdmin: boolean }>;
  /** Whether an organization, a user, or nothing has this name. */
  ownerKind(name: string): Promise<"organization" | "user" | "missing">;
  /** Whether the token's account may create repositories in the organization. */
  canCreateIn(org: string, login: string): Promise<boolean>;
  /** The repository at an address, following a rename or move, or null. */
  lookup(owner: string, name: string): Promise<GiteaRepoInfo | null>;
  /** What sits at exactly this address. */
  probe(owner: string, name: string): Promise<NameState>;
  /** A mirror of the row's source anywhere on the destination. */
  searchBySource(row: PlacementCandidate): Promise<GiteaRepoInfo | null>;
}

const lower = (owner: string, name: string) => `${owner}/${name}`.toLowerCase();
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The real destination calls. */
export function giteaPlacementDeps(config: Partial<Config>): PlacementDeps {
  const base = `${config.giteaConfig?.url ?? ""}/api/v1`;
  const token = decryptConfigTokens(config as Config).giteaConfig?.token ?? "";
  const auth = { Authorization: `token ${token}` };
  const enc = encodeURIComponent;
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      return (await httpGet<T>(`${base}${path}`, auth)).data ?? null;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  };
  let me: Promise<{ login: string; isAdmin: boolean }> | null = null;

  return {
    me: () =>
      (me ??= get<{ login: string; is_admin?: boolean }>("/user").then((user) => ({
        login: user?.login ?? "",
        isAdmin: user?.is_admin === true,
      }))),
    ownerKind: async (name) => {
      if (await get(`/orgs/${enc(name)}`)) return "organization";
      return (await get(`/users/${enc(name)}`)) ? "user" : "missing";
    },
    canCreateIn: async (org, login) => {
      const permissions = await get<{ can_create_repository?: boolean }>(
        `/users/${enc(login)}/orgs/${enc(org)}/permissions`
      );
      return permissions?.can_create_repository === true;
    },
    lookup: (owner, name) => get<GiteaRepoInfo>(`/repos/${enc(owner)}/${enc(name)}`),
    probe: async (owner, name) => {
      try {
        const response = await httpRequest<GiteaRepoInfo>(`${base}/repos/${enc(owner)}/${enc(name)}`, {
          headers: auth,
          redirect: "manual",
        });
        return { state: "taken", info: response.data };
      } catch (error) {
        // 404: nothing there. A 3xx is a redirect left by a rename or a move,
        // which Gitea replaces when a repository takes the name.
        if (error instanceof HttpError && (error.status === 404 || (error.status >= 300 && error.status < 400))) {
          return { state: "free" };
        }
        throw error;
      }
    },
    searchBySource: (row) =>
      findGiteaMirrorBySource({ config, repository: { name: row.sourceName, cloneUrl: row.cloneUrl, url: null } as any }),
  };
}

/** The rows with the place the settings give each, the way a mirror run works it out. */
async function loadScanRows(userId: string, config: Partial<Config>): Promise<PlacementScanRow[]> {
  const rows = (await db.select().from(repositories).where(eq(repositories.userId, userId))) as Repository[];
  const orgRows = await db
    .select({ name: organizations.name, destinationOrg: organizations.destinationOrg })
    .from(organizations)
    .where(eq(organizations.userId, userId));
  const orgDestinations = new Map(
    orgRows.filter((row) => row.destinationOrg).map((row) => [row.name, row.destinationOrg as string])
  );
  const sourceRows = await db
    .select({ id: sources.id, username: sources.username })
    .from(sources)
    .where(eq(sources.userId, userId));
  const sourceUsernames = new Map(sourceRows.map((row) => [row.id, row.username]));

  return rows.map((row) => {
    let onConfiguredDestination = true;
    try {
      assertRepositoryMatchesConfiguredDestination({ repository: row, config });
    } catch {
      onConfiguredDestination = false;
    }

    const starred = usesStarredDestination(row, config.githubConfig?.starredReposMode);
    const organizationDestination =
      !starred && !row.destinationOrg && row.organization ? orgDestinations.get(row.organization) : undefined;
    const via: PlacementVia = starred
      ? "starred"
      : row.destinationOrg
        ? "repository"
        : organizationDestination
          ? "organization"
          : "strategy";
    let target: PlacementScanRow["target"] = null;
    try {
      const owner = resolveDestinationOwner({
        config: { userId, githubConfig: config.githubConfig as any, giteaConfig: config.giteaConfig as any },
        repository: row,
        organizationDestination,
        sourceUsername: row.sourceId ? sourceUsernames.get(row.sourceId) ?? undefined : undefined,
      });
      target = { owner, via };
    } catch {
      target = null;
    }
    return { row, target, onConfiguredDestination };
  });
}

export async function scanUserPlacement(userId: string, config: Partial<Config>): Promise<PlacementScan> {
  return scanPlacement(await loadScanRows(userId, config));
}

/** The footer's count: database only, no destination calls. */
export async function placementSummary(userId: string, config: Partial<Config>): Promise<PlacementSummary> {
  if (usesPushEngine(config)) return { supported: false, outOfPlace: 0, inPlace: 0 };
  const scan = await scanUserPlacement(userId, config);
  return { supported: true, outOfPlace: scan.candidates.length, inPlace: scan.inPlace };
}

const OWNER_BLOCKS: Record<"user" | "no-access" | "invalid" | "reserved", (owner: string) => { reason: string; hint: string }> = {
  user: (owner) => ({
    reason: `${owner} is a person's account on the destination, not an organization.`,
    hint: "Moves only go to organizations and to your own account. Give these repositories another destination.",
  }),
  "no-access": (owner) => ({
    reason: `Your destination account cannot create repositories in ${owner}.`,
    hint: `Ask an owner of ${owner} to give your account a team that can, or use an administrator's token.`,
  }),
  invalid: (owner) => ({
    reason: `${owner} is not a valid organization name on the destination.`,
    hint: "Organization names may only use letters, digits, dots, dashes and underscores.",
  }),
  reserved: (owner) => ({
    reason: `The destination keeps the name ${owner} for itself, so no organization can have it.`,
    hint: "Give these repositories another destination.",
  }),
};

/**
 * Check every out-of-place mirror on the destination and plan its move:
 * where the mirror really is, whether its new owner can take it, and the
 * name it ends with. With `rename`, a moved mirror takes its source's name
 * like a new mirror would; when that name is taken it keeps its current
 * name if that one is free, and is blocked otherwise. A move never makes
 * up a new name.
 */
export async function previewPlacement({
  scan,
  config,
  rename,
  deps,
}: {
  scan: PlacementScan;
  config: Partial<Config>;
  rename: boolean;
  deps: PlacementDeps;
}): Promise<PlacementPreview> {
  const moves: PlannedMove[] = [];
  const blocked: BlockedMove[] = [];
  const defaultOwner = (config.giteaConfig?.defaultOwner ?? "").trim();

  // 1. Where each mirror is now. The recorded location first, following a
  //    rename or move made on the destination; then a search by source for a
  //    mirror moved without a redirect.
  type Located = { row: PlacementCandidate; current: { owner: string; name: string }; info: GiteaRepoInfo | null };
  const located = await mapLimit(scan.candidates, LOOKUP_CONCURRENCY, async (row): Promise<Located | BlockedMove> => {
    const from = `${row.from.owner}/${row.from.name}`;
    const block = (reason: string, hint?: string): BlockedMove => ({
      id: row.id,
      fullName: row.fullName,
      from,
      to: `${row.target.owner}/${rename ? row.sourceName : row.from.name}`,
      via: row.target.via,
      reason,
      hint,
    });
    try {
      let info = await deps.lookup(row.from.owner, row.from.name);
      if (!isRecordedMirror(info, row.cloneUrl)) {
        const hit = await deps.searchBySource(row);
        info = hit && isMirrorOfSource(hit, row.cloneUrl) ? hit : null;
      }
      if (!info) {
        return block(
          `The mirror is not on the destination at ${from}.`,
          "Run Reconcile with destination on the Automation tab, or mirror it again."
        );
      }
      const current = splitLocation(info.full_name) ?? { owner: ownerLogin(info) || row.from.owner, name: info.name };
      return { row, current, info };
    } catch (error) {
      return block(`Could not look it up on the destination: ${describe(error)}`);
    }
  });

  // 2. What each new owner is. Once per owner.
  const me = await deps.me();
  const ownerStates = new Map<string, OwnerState>();
  const owners = [...new Set(scan.candidates.map((row) => row.target.owner))];
  await mapLimit(owners, LOOKUP_CONCURRENCY, async (owner) => {
    let state: OwnerState;
    try {
      if (defaultOwner && defaultOwner.toLowerCase() === owner.toLowerCase()) state = { kind: "account" };
      else if (me.login && me.login.toLowerCase() === owner.toLowerCase()) state = { kind: "account" };
      else if (!OWNER_NAME_PATTERN.test(owner)) state = { kind: "invalid" };
      else {
        const kind = await deps.ownerKind(owner);
        if (kind === "user") state = { kind: "user" };
        else if (kind === "missing") state = isReservedOwnerName(owner, config.giteaConfig?.provider) ? { kind: "reserved" } : { kind: "new-organization" };
        else state = me.isAdmin || (await deps.canCreateIn(owner, me.login)) ? { kind: "organization" } : { kind: "no-access" };
      }
    } catch (error) {
      state = { kind: "error", message: describe(error) };
    }
    ownerStates.set(owner.toLowerCase(), state);
  });

  // 3. Names. Probed up front in parallel, then decided in order so two
  //    mirrors never get the same place.
  const probes = new Map<string, Promise<NameState>>();
  const probe = (owner: string, name: string) => {
    const key = lower(owner, name);
    if (!probes.has(key)) probes.set(key, deps.probe(owner, name));
    return probes.get(key)!;
  };
  const ready = located.filter((entry): entry is Located => "current" in entry);
  await mapLimit(ready, LOOKUP_CONCURRENCY, async ({ row, current }) => {
    await probe(row.target.owner, rename ? row.sourceName : current.name).catch(() => undefined);
  });

  // owner/name -> the row that takes it in this plan.
  const claimed = new Map<string, string>();

  for (const entry of located) {
    if (!("current" in entry)) {
      blocked.push(entry);
      continue;
    }
    const { row, current, info } = entry;
    const target = row.target.owner;
    const from = `${current.owner}/${current.name}`;
    const recorded = `${row.from.owner}/${row.from.name}`;
    const note =
      lower(current.owner, current.name) === lower(row.from.owner, row.from.name)
        ? undefined
        : current.owner.toLowerCase() === row.from.owner.toLowerCase()
          ? `Renamed on the destination since it was mirrored (was ${recorded}).`
          : `Moved on the destination since it was mirrored (was ${recorded}).`;
    const block = (to: string, reason: string, hint?: string) =>
      blocked.push({ id: row.id, fullName: row.fullName, from, to, via: row.target.via, reason, hint });

    const ownerState = ownerStates.get(target.toLowerCase()) ?? { kind: "error", message: "not checked" };

    // Moved there by hand already: only the record changes.
    if (current.owner.toLowerCase() === target.toLowerCase()) {
      claimed.set(lower(current.owner, current.name), row.fullName);
      moves.push({
        id: row.id, fullName: row.fullName, from: `${row.from.owner}/${row.from.name}`, to: from, via: row.target.via,
        kind: "record", ownerState: ownerState.kind === "account" ? "account" : "organization", renamed: false, order: "transfer-first",
        note: `Already at ${from} on the destination. Gitea Mirror only updates where it looks for it.`,
      });
      continue;
    }

    const desired = rename ? row.sourceName : current.name;
    if (ownerState.kind === "error") {
      block(`${target}/${desired}`, `Could not check ${target} on the destination: ${ownerState.message}`);
      continue;
    }
    if (ownerState.kind === "user" || ownerState.kind === "no-access" || ownerState.kind === "invalid" || ownerState.kind === "reserved") {
      const { reason, hint } = OWNER_BLOCKS[ownerState.kind](target);
      block(`${target}/${desired}`, reason, hint);
      continue;
    }
    if (!me.isAdmin && info?.permissions && info.permissions.admin === false) {
      block(
        `${target}/${desired}`,
        `Your destination account cannot transfer ${from}: that takes admin rights on the repository.`,
        "Use an administrator's token, or an account that owns the repository."
      );
      continue;
    }

    // What a name at the target holds for this row.
    const check = async (name: string): Promise<{ ok: true } | { ok: false; why: string } | { copy: GiteaRepoInfo }> => {
      const by = claimed.get(lower(target, name));
      if (by) return { ok: false, why: `the mirror of ${by} is moving to ${target}/${name}` };
      if (ownerState.kind === "new-organization") return { ok: true };
      const state = await probe(target, name);
      if (state.state === "free") return { ok: true };
      if (isMirrorOfSource(state.info, row.cloneUrl)) return { copy: state.info };
      return {
        ok: false,
        why: `${target}/${name} is taken by ${state.info.mirror ? "a mirror of another repository" : "another repository"}`,
      };
    };

    let finalName = desired;
    let keptNameBecause: string | undefined;
    let result;
    try {
      result = await check(desired);
      if ("ok" in result && !result.ok && rename && desired.toLowerCase() !== current.name.toLowerCase()) {
        const fallback = await check(current.name);
        if (!("ok" in fallback) || fallback.ok) {
          keptNameBecause = `${result.why}.`;
          finalName = current.name;
          result = fallback;
        }
      }
    } catch (error) {
      block(`${target}/${desired}`, `Could not check ${target}/${desired} on the destination: ${describe(error)}`);
      continue;
    }

    if ("copy" in result) {
      // A mirror of the same source already sits there, left by an earlier
      // run. The row points at it; the copy it had stays for the user.
      const at = splitLocation(result.copy.full_name) ?? { owner: target, name: finalName };
      claimed.set(lower(at.owner, at.name), row.fullName);
      moves.push({
        id: row.id, fullName: row.fullName, from, to: `${at.owner}/${at.name}`, via: row.target.via,
        kind: "record", ownerState: ownerState.kind, renamed: false, order: "transfer-first",
        note: `${at.owner}/${at.name} is already a mirror of the same repository, so Gitea Mirror switches to it. ${from} stays on the destination for you to delete.`,
      });
      continue;
    }
    if (!result.ok) {
      // Suggest the source name only when it is a different name.
      const hint =
        rename || row.sourceName.toLowerCase() === current.name.toLowerCase()
          ? "Rename or remove that repository on the destination, or give this one another destination."
          : `Rename or remove that repository on the destination, give this one another destination, or turn on Use the source name to move it as ${row.sourceName}.`;
      const reason = result.why.startsWith("the ") ? `T${result.why.slice(1)}` : result.why;
      block(`${target}/${desired}`, `${reason}.`, hint);
      continue;
    }

    // A rename is done after the transfer, under the current name; when that
    // name is taken at the target, before it, in the current owner.
    const renamed = finalName !== current.name;
    let order: PlannedMove["order"] = "transfer-first";
    if (renamed && finalName.toLowerCase() !== current.name.toLowerCase()) {
      try {
        const viaCurrent = await check(current.name);
        if (!("ok" in viaCurrent) || !viaCurrent.ok) {
          const there = await probe(current.owner, finalName);
          if (there.state !== "free") {
            block(
              `${target}/${finalName}`,
              `${target}/${current.name} and ${current.owner}/${finalName} are both taken, so there is no way to move and rename it.`,
              "Rename one of them on the destination."
            );
            continue;
          }
          order = "rename-first";
        }
      } catch (error) {
        block(`${target}/${finalName}`, `Could not check the destination: ${describe(error)}`);
        continue;
      }
    }

    claimed.set(lower(target, finalName), row.fullName);
    moves.push({
      id: row.id, fullName: row.fullName, from, to: `${target}/${finalName}`, via: row.target.via,
      kind: "move", ownerState: ownerState.kind, renamed, keptNameBecause, order, note,
    });
  }

  return { rename, moves, blocked, skipped: scan.skipped, inPlace: scan.inPlace };
}

/**
 * The user's active configuration, ready for a placement call, or the
 * reason a placement call cannot run (the HTTP status and message).
 */
export async function loadPlacementConfig(
  userId: string
): Promise<{ config: Partial<Config> } | { status: number; error: string }> {
  const { and } = await import("drizzle-orm");
  const { configs } = await import("@/lib/db");
  const [row] = await db
    .select()
    .from(configs)
    .where(and(eq(configs.userId, userId), eq(configs.isActive, true)))
    .limit(1);
  if (!row) return { status: 404, error: "No active configuration found" };
  const config = row as unknown as Partial<Config>;
  if (usesPushEngine(config)) {
    return {
      status: 400,
      error: "Moving mirrors needs a Gitea or Forgejo destination. On GitHub and GitLab the push engine keeps repositories where it created them.",
    };
  }
  if (!config.giteaConfig?.url || !config.giteaConfig?.token || !config.giteaConfig?.defaultOwner) {
    return { status: 400, error: "Configure the destination URL, username and token first" };
  }
  return { config };
}
