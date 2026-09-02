/**
 * The database aware side of the push engine.
 *
 * Mirrors the statuses, mirror jobs and activity rows the Gitea path
 * writes, so the dashboard, recovery and cleanup see a push target exactly
 * like a pull mirror. The git work itself lives in engine.ts.
 */
import { eq } from "drizzle-orm";
import { db, repositories } from "@/lib/db";
import type { Config, Repository } from "@/lib/db/schema";
import { createMirrorJob } from "@/lib/helpers";
import { getGiteaRepoOwnerAsync } from "@/lib/gitea";
import {
  assertRepositoryMatchesConfiguredSource,
  resolveSourceConnection,
} from "@/lib/source-providers";
import { getDecryptedGitHubToken } from "@/lib/utils/config-encryption";
import { buildSourceAuthPayload } from "@/lib/utils/mirror-source-auth";
import {
  assertRepositoryMatchesConfiguredDestination,
  createPushTargetFromConfig,
  resolveDestinationIdentity,
  resolvePushDestinationKind,
} from "@/lib/destination-connection";
import { DESTINATION_PROVIDER_LABELS } from "@/lib/destination-kinds";
import { repoStatusEnum } from "@/types/Repository";
import { runPushMirror, type PushMirrorOutcome } from "./engine";
import type { GitCredentials } from "./git";
import { clonePathForRepository } from "./paths";
import type { PushTarget } from "./targets/types";

export type PushMirrorMode = "mirror" | "sync";

export interface PushMirrorRepositoryOptions {
  config: Partial<Config>;
  repository: Repository;
  /** "mirror" for the first push, "sync" for later ones. Picks statuses and the job type. */
  mode?: PushMirrorMode;
  /** Test hook: use this target instead of the one built from the config. */
  target?: PushTarget;
}

/** Split a recorded `owner/name` mirror location. */
export function parseMirroredLocation(location: string | null | undefined): { owner: string; name: string } | null {
  const trimmed = (location || "").trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

/** The credentials git uses to fetch from the source, per source host. */
export function resolveSourceCredentials(config: Partial<Config>, repository: Repository): GitCredentials | null {
  const token = config.githubConfig?.token ? getDecryptedGitHubToken(config as Config) : "";
  const connection = resolveSourceConnection(config, { token });
  const payload = buildSourceAuthPayload({
    provider: connection.provider,
    token,
    username: connection.username,
    repositoryOwner: repository.owner,
  });
  if (!("auth_username" in payload) || !payload.auth_password) return null;
  return { username: payload.auth_username, token: payload.auth_password };
}

/** Private on the target unless the source repository is public and visibility is preserved. */
export function resolveTargetPrivacy(config: Partial<Config>, repository: Repository): boolean {
  if (repository.isPrivate || repository.visibility === "private" || repository.visibility === "internal") {
    return true;
  }
  const preserve = config.giteaConfig?.preserveVisibility ?? true;
  if (preserve) return false;
  return config.giteaConfig?.visibility === "private";
}

export async function pushMirrorRepository({
  config,
  repository,
  mode,
  target,
}: PushMirrorRepositoryOptions): Promise<PushMirrorOutcome> {
  if (!config.userId || !config.giteaConfig?.url || !config.giteaConfig?.token) {
    throw new Error("A destination URL and token are required.");
  }
  if (!config.giteaConfig.defaultOwner) {
    throw new Error("The destination account name is required.");
  }

  const kind = resolvePushDestinationKind(config);
  const label = DESTINATION_PROVIDER_LABELS[kind];
  const destination = resolveDestinationIdentity(config);

  // Never send another host's token in either direction.
  assertRepositoryMatchesConfiguredSource({ repository, config });
  assertRepositoryMatchesConfiguredDestination({ repository, config });

  const recorded = parseMirroredLocation(repository.mirroredLocation);
  const effectiveMode: PushMirrorMode = mode ?? (recorded ? "sync" : "mirror");
  const owner = recorded?.owner ?? (await getGiteaRepoOwnerAsync({ config, repository }));
  const name = recorded?.name ?? repository.name;
  const location = `${owner}/${name}`;
  const busyStatus = effectiveMode === "mirror" ? "mirroring" : "syncing";
  const doneStatus = effectiveMode === "mirror" ? "mirrored" : "synced";
  const jobType = effectiveMode === "mirror" ? "mirror" : "sync";
  const logPrefix = `[Push ${label}] ${repository.fullName}:`;

  await db
    .update(repositories)
    .set({
      status: repoStatusEnum.parse(busyStatus),
      mirroredLocation: location,
      destinationProvider: destination.provider,
      destinationUrl: destination.url,
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, repository.id!));

  await createMirrorJob({
    userId: config.userId,
    repositoryId: repository.id,
    repositoryName: repository.name,
    message:
      effectiveMode === "mirror"
        ? `Started mirroring repository: ${repository.name}`
        : `Started syncing repository: ${repository.name}`,
    details: `Repository ${repository.fullName} is being pushed to ${label} at ${location}.`,
    status: busyStatus,
    jobType,
  });

  try {
    const outcome = await runPushMirror({
      clonePath: clonePathForRepository(repository),
      sourceCloneUrl: repository.cloneUrl,
      sourceCredentials: resolveSourceCredentials(config, repository),
      target: target ?? createPushTargetFromConfig(config),
      owner,
      name,
      isPrivate: resolveTargetPrivacy(config, repository),
      description: repository.description,
      defaultBranch: repository.defaultBranch,
      log: (message) => console.log(`${logPrefix} ${message}`),
    });

    const finalLocation = `${outcome.targetRepository.owner}/${outcome.targetRepository.name}`;
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse(doneStatus),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: finalLocation,
        destinationProvider: destination.provider,
        destinationUrl: destination.url,
      })
      .where(eq(repositories.id, repository.id!));

    const summary =
      outcome.cloned || outcome.targetRepository.created
        ? `first push of ${outcome.refsAfter.size} refs`
        : outcome.pushed
          ? `${outcome.changedRefs} ref(s) updated`
          : "already up to date";
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message:
        effectiveMode === "mirror"
          ? `Successfully mirrored repository: ${repository.name}`
          : `Successfully synced repository: ${repository.name}`,
      details: `Repository ${repository.fullName} was pushed to ${label} at ${finalLocation} (${summary}${
        outcome.batches ? `, in ${outcome.batches} batches` : ""
      }).`,
      status: doneStatus,
      jobType,
    });

    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`${logPrefix} failed: ${message}`);

    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: message,
      })
      .where(eq(repositories.id, repository.id!));

    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message:
        effectiveMode === "mirror"
          ? `Failed to mirror repository: ${repository.name}`
          : `Failed to sync repository: ${repository.name}`,
      details: `Repository ${repository.fullName} could not be pushed to ${label}. Error: ${message}`,
      status: "failed",
      jobType,
    });

    throw new Error(
      effectiveMode === "mirror" ? `Failed to mirror repository: ${message}` : `Failed to sync repository: ${message}`
    );
  }
}
