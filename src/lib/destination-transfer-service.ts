/**
 * Move mirrors to another owner on the destination (Gitea or Forgejo), for
 * issue #400. One repository at a time, or every mirrored repository of an
 * organization. Nothing is ever deleted: when a mirror of the same source
 * already sits under the target, the row is pointed at it and the old copy
 * is left where it is for the user to remove.
 */

import { and, asc, eq } from "drizzle-orm";
import { db, repositories } from "@/lib/db";
import type { Repository } from "@/lib/db/schema";
import type { Config } from "@/types/config";
import { HttpError, httpGet } from "@/lib/http-client";
import { decryptConfigTokens } from "@/lib/utils/config-encryption";
import {
  findGiteaMirrorBySource,
  getGiteaRepoInfo,
  getOrCreateGiteaOrgEnhanced,
  transferGiteaRepo,
  type GiteaTransferResult,
} from "@/lib/gitea-enhanced";
import { isMirrorOfSource } from "@/lib/utils/mirror-source-match";
import {
  assertRepositoryMatchesConfiguredDestination,
  usesPushEngine,
} from "@/lib/destination-connection";
import { createMirrorJob } from "@/lib/helpers";
import { processInParallel } from "@/lib/utils/concurrency";
import {
  MoveMirrorError,
  isRecordedMirror,
  ownerLogin,
  planOrganizationMove,
  splitLocation,
  type MoveResult,
  type OrganizationMoveResult,
} from "@/lib/destination-transfer";

const ORG_MOVE_CONCURRENCY = 2;

/** The destination calls a move makes; injectable so the decisions can be tested without a server. */
export interface MoveDeps {
  getRepoInfo: typeof getGiteaRepoInfo;
  searchBySource: typeof findGiteaMirrorBySource;
  ensureOwner: (args: { config: Partial<Config>; owner: string }) => Promise<void>;
  transfer: typeof transferGiteaRepo;
}

/**
 * Make sure the target owner exists, the way a mirror run does: the account
 * itself always exists, any other name is looked up as a user or
 * organization and created as an organization when the destination has
 * neither.
 */
export async function ensureDestinationOwner({
  config,
  owner,
}: {
  config: Partial<Config>;
  owner: string;
}): Promise<void> {
  const defaultOwner = (config.giteaConfig?.defaultOwner ?? "").trim();
  if (defaultOwner && defaultOwner.toLowerCase() === owner.toLowerCase()) return;
  if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
    throw new Error("Gitea config is required.");
  }

  const decrypted = decryptConfigTokens(config as Config);
  try {
    // Gitea serves organizations from /users/{name} as well, so one call
    // covers both; a 404 means the name is free.
    await httpGet(`${config.giteaConfig.url}/api/v1/users/${encodeURIComponent(owner)}`, {
      Authorization: `token ${decrypted.giteaConfig.token}`,
    });
    return;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
  }

  await getOrCreateGiteaOrgEnhanced({ orgName: owner, config });
}

const defaultDeps: MoveDeps = {
  getRepoInfo: getGiteaRepoInfo,
  searchBySource: findGiteaMirrorBySource,
  ensureOwner: ensureDestinationOwner,
  transfer: transferGiteaRepo,
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transferError(
  error: unknown,
  { fullName, from, to, target }: { fullName: string; from: string; to: string; target: string }
): MoveMirrorError {
  if (error instanceof MoveMirrorError) return error;
  if (error instanceof HttpError) {
    switch (error.status) {
      case 409:
        return new MoveMirrorError(
          `A transfer of ${from} is already waiting for acceptance on the destination. Accept or reject it there first.`,
          409,
          "transfer-pending"
        );
      case 422:
        return new MoveMirrorError(
          `${to} already exists on the destination, so ${from} cannot be moved there. Rename or remove it there first.`,
          409,
          "name-taken"
        );
      case 403:
        return new MoveMirrorError(
          `The destination token is not allowed to transfer ${from}. It has to own the repository, or be an administrator.`,
          403,
          "forbidden"
        );
      case 404:
        return new MoveMirrorError(
          `The destination could not find ${from} or the owner ${target}.`,
          409,
          "not-on-destination"
        );
      default:
        return new MoveMirrorError(
          `The destination refused to transfer ${fullName} (${from}): ${error.message}`,
          502,
          "destination-error"
        );
    }
  }
  return new MoveMirrorError(
    `Could not transfer ${fullName} (${from}): ${describeError(error)}`,
    502,
    "destination-error"
  );
}

async function recordLocation({
  userId,
  repository,
  location,
}: {
  userId: string;
  repository: Repository;
  location: string;
}): Promise<void> {
  const recorded = (repository.mirroredLocation ?? "").trim();
  if (recorded === location && repository.status !== "failed") return;
  await db
    .update(repositories)
    .set({
      mirroredLocation: location,
      // A row that failed because its mirror was not where the app looked
      // is healthy again once the app knows where the mirror is.
      ...(repository.status === "failed" ? { status: "mirrored", errorMessage: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(repositories.userId, userId), eq(repositories.id, repository.id!)));
}

/**
 * Move one repository's mirror under `newOwner`. Finds the mirror first (at
 * the recorded location, or anywhere on the destination when someone moved
 * it by hand), refuses to overwrite a different repository of the same
 * name, creates the target organization when needed, and asks the
 * destination to transfer. Records where the mirror is afterwards.
 *
 * Throws MoveMirrorError with the HTTP status a route should answer with.
 * The caller writes `destinationOrg`; this only touches `mirroredLocation`
 * (and clears a failed status).
 */
export async function moveMirror({
  userId,
  config,
  repository,
  newOwner,
  deps,
}: {
  userId: string;
  config: Partial<Config>;
  repository: Repository;
  newOwner: string;
  deps?: Partial<MoveDeps>;
}): Promise<MoveResult> {
  const io: MoveDeps = { ...defaultDeps, ...deps };
  const target = newOwner.trim();

  if (usesPushEngine(config)) {
    throw new MoveMirrorError(
      "Moving a mirror needs a Gitea or Forgejo destination. On GitHub and GitLab the push engine keeps repositories where it created them.",
      400,
      "destination-unsupported"
    );
  }

  const recorded = splitLocation(repository.mirroredLocation);
  if (!recorded) {
    return {
      outcome: "not-mirrored",
      from: "",
      to: "",
      message: `${repository.fullName} has not been mirrored yet, so there is nothing to move. The next mirror run uses the new destination.`,
    };
  }
  const from = `${recorded.owner}/${recorded.name}`;

  try {
    assertRepositoryMatchesConfiguredDestination({ repository, config });
  } catch (error) {
    throw new MoveMirrorError(describeError(error), 409, "destination-mismatch");
  }

  // 1. Where is the mirror now? The recorded location first, then a search
  //    for anyone who transferred it by hand (the case in issue #400).
  let current = recorded;
  try {
    const atRecorded = await io.getRepoInfo({ config, owner: recorded.owner, repoName: recorded.name });
    if (!isRecordedMirror(atRecorded, repository.cloneUrl)) {
      const hit = await io.searchBySource({ config, repository });
      const hitOwner = ownerLogin(hit);
      if (hit && hitOwner && hit.name && isMirrorOfSource(hit, repository.cloneUrl)) {
        current = { owner: hitOwner, name: hit.name };
      } else {
        throw new MoveMirrorError(
          `${repository.fullName} is not on the destination at ${from}. Run Reconcile with destination, or mirror it again.`,
          409,
          "not-on-destination"
        );
      }
    }
  } catch (error) {
    if (error instanceof MoveMirrorError) throw error;
    throw new MoveMirrorError(
      `Could not look up ${from} on the destination: ${describeError(error)}`,
      502,
      "destination-error"
    );
  }
  const currentLocation = `${current.owner}/${current.name}`;
  const to = `${target}/${current.name}`;

  // 2. Already under the new owner: nothing to transfer, only to record.
  if (current.owner.toLowerCase() === target.toLowerCase()) {
    await recordLocation({ userId, repository, location: currentLocation });
    return {
      outcome: "recorded",
      from,
      to: currentLocation,
      message: `${repository.fullName} is already under ${current.owner}, at ${currentLocation}.`,
    };
  }

  // 3. The name has to be free under the target, unless what sits there is
  //    another mirror of this same source (a copy made by an earlier retry).
  let atTarget;
  try {
    atTarget = await io.getRepoInfo({ config, owner: target, repoName: current.name });
  } catch (error) {
    throw new MoveMirrorError(
      `Could not look up ${to} on the destination: ${describeError(error)}`,
      502,
      "destination-error"
    );
  }
  if (atTarget) {
    if (isMirrorOfSource(atTarget, repository.cloneUrl)) {
      const location = `${ownerLogin(atTarget) || target}/${atTarget.name || current.name}`;
      await recordLocation({ userId, repository, location });
      await createMirrorJob({
        userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Recorded ${location} as the mirror of ${repository.fullName}`,
        details: `${location} already mirrors the same source. The copy at ${currentLocation} was left alone.`,
        status: "mirrored",
        skipNotification: true,
      });
      return {
        outcome: "recorded",
        from,
        to: location,
        message: `${location} already mirrors ${repository.fullName}, so the row now points at it. The copy at ${currentLocation} was left alone; remove it on the destination if you do not need it.`,
      };
    }
    throw new MoveMirrorError(
      `${to} already exists on the destination and is not a mirror of ${repository.fullName}. Rename or remove it there first.`,
      409,
      "name-taken"
    );
  }

  // 4. The owner has to exist; organizations are created the way a mirror run creates them.
  try {
    await io.ensureOwner({ config, owner: target });
  } catch (error) {
    throw transferError(error, { fullName: repository.fullName, from: currentLocation, to, target });
  }

  // 5. Ask the destination to move it.
  let result: GiteaTransferResult;
  try {
    result = await io.transfer({ config, owner: current.owner, repoName: current.name, newOwner: target });
  } catch (error) {
    throw transferError(error, { fullName: repository.fullName, from: currentLocation, to, target });
  }

  if (result.pending) {
    // The repository stays where it is until someone accepts. Sync keeps
    // using the recorded location, and follows the move once it happens.
    await recordLocation({ userId, repository, location: currentLocation });
    await createMirrorJob({
      userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Asked the destination to transfer ${repository.fullName} to ${target}`,
      details: `The destination is waiting for an owner of ${target} to accept. The mirror stays at ${currentLocation} until then.`,
      status: "mirrored",
      skipNotification: true,
    });
    return {
      outcome: "pending",
      from,
      to,
      message: `The destination is waiting for an owner of ${target} to accept the transfer of ${currentLocation}. The mirror keeps syncing where it is until then, and sync follows it once accepted.`,
    };
  }

  const landed = `${ownerLogin(result.repo) || target}/${result.repo?.name || current.name}`;
  await recordLocation({ userId, repository, location: landed });
  await createMirrorJob({
    userId,
    repositoryId: repository.id,
    repositoryName: repository.name,
    message: `Moved ${repository.fullName} to ${landed} on the destination`,
    details: `Was at ${currentLocation}.`,
    status: "mirrored",
    skipNotification: true,
  });
  console.log(`[Move] ${repository.fullName}: ${currentLocation} -> ${landed}`);

  return {
    outcome: "moved",
    from,
    to: landed,
    message: `Moved ${repository.fullName} from ${currentLocation} to ${landed}.`,
  };
}

/**
 * Move every mirrored repository of an organization under the owner its new
 * destination names (or the strategy's owner when the override is removed).
 * A dry run only returns the plan, which the confirmation dialog shows.
 * Each move is independent: one failure is reported and the rest go ahead.
 */
export async function moveOrganizationMirrors({
  userId,
  config,
  organization,
  destinationOrg,
  dryRun,
  deps,
  strategyOwnerFor,
}: {
  userId: string;
  config: Partial<Config>;
  organization: { id?: string; name: string };
  destinationOrg: string | null;
  dryRun: boolean;
  deps?: Partial<MoveDeps>;
  /** Where the strategy puts a row without any override; injectable for tests. */
  strategyOwnerFor?: (row: Repository) => string;
}): Promise<OrganizationMoveResult> {
  if (usesPushEngine(config)) {
    throw new MoveMirrorError(
      "Moving mirrors needs a Gitea or Forgejo destination. On GitHub and GitLab the push engine keeps repositories where it created them.",
      400,
      "destination-unsupported"
    );
  }

  const rows = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.userId, userId), eq(repositories.organization, organization.name)))
    .orderBy(asc(repositories.fullName))) as Repository[];

  const override = (destinationOrg ?? "").trim();
  let resolveStrategyOwner = strategyOwnerFor;
  if (!resolveStrategyOwner) {
    const { getGiteaRepoOwner } = await import("@/lib/gitea");
    resolveStrategyOwner = (row) => getGiteaRepoOwner({ config, repository: row });
  }
  const plan = planOrganizationMove({
    rows,
    targetOwnerFor: (row) => {
      if (override) return override;
      try {
        // Without an override the organization falls back to the strategy,
        // which is what the next mirror run would use for these rows.
        return resolveStrategyOwner!(row as Repository);
      } catch {
        return "";
      }
    },
  });

  const result: OrganizationMoveResult = {
    dryRun,
    plan,
    moved: [],
    pending: [],
    recorded: [],
    failed: [],
  };
  if (dryRun || plan.moves.length === 0) return result;

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  await processInParallel(
    plan.moves,
    async (entry) => {
      const row = rowsById.get(entry.id);
      const target = splitLocation(entry.to)?.owner ?? "";
      if (!row || !target) {
        result.failed.push({ fullName: entry.fullName, error: "row or target missing" });
        return;
      }
      try {
        const moved = await moveMirror({ userId, config, repository: row, newOwner: target, deps });
        const summary = { fullName: entry.fullName, from: moved.from, to: moved.to };
        if (moved.outcome === "moved") result.moved.push(summary);
        else if (moved.outcome === "pending") result.pending.push(summary);
        else if (moved.outcome === "recorded") result.recorded.push(summary);
      } catch (error) {
        result.failed.push({ fullName: entry.fullName, error: describeError(error) });
      }
    },
    ORG_MOVE_CONCURRENCY
  );

  const sortByName = (a: { fullName: string }, b: { fullName: string }) => a.fullName.localeCompare(b.fullName);
  result.moved.sort(sortByName);
  result.pending.sort(sortByName);
  result.recorded.sort(sortByName);
  result.failed.sort(sortByName);

  const targetLabel = override || "the strategy's owner";
  await createMirrorJob({
    userId,
    organizationId: organization.id,
    organizationName: organization.name,
    message: `Moved the mirrors of ${organization.name} to ${targetLabel}`,
    details: `Moved ${result.moved.length}, waiting for acceptance ${result.pending.length}, recorded ${result.recorded.length}, failed ${result.failed.length}, skipped ${plan.skipped.length}.`,
    status: result.failed.length > 0 && result.moved.length === 0 ? "failed" : "mirrored",
    skipNotification: true,
  });

  return result;
}
