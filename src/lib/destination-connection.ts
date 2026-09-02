/**
 * The destination a config points at, server side.
 *
 * destination-kinds.ts stays import free for the client; this module adds
 * the pieces that need the config: the decrypted token, the account name,
 * and the guard that stops a repository from being pushed to a host other
 * than the one it was mirrored to.
 */
import type { Config, Repository } from "@/lib/db/schema";
import { getDecryptedGiteaToken } from "@/lib/utils/config-encryption";
import {
  describeDestination,
  getRepositoryDestination,
  isPushDestinationKind,
  isRepositoryOnConfiguredDestination,
  normalizeDestinationBaseUrl,
  normalizeDestinationProviderKind,
  type DestinationProviderKind,
  type PushDestinationKind,
  type RepositoryDestination,
  type RepositoryDestinationFields,
} from "./destination-kinds";
import { createPushTarget, type PushTarget } from "./push-engine/targets";

export interface DestinationConnection extends RepositoryDestination {
  /** The account the token belongs to on the destination. */
  username: string;
  token: string;
  organization?: string;
}

/** The destination kind a config selects, defaulting to Gitea. */
export function resolveDestinationKind(config: Partial<Config> | null | undefined): DestinationProviderKind {
  return normalizeDestinationProviderKind(config?.giteaConfig?.provider);
}

/** True when mirrors for this config go through the push engine. */
export function usesPushEngine(config: Partial<Config> | null | undefined): boolean {
  return isPushDestinationKind(resolveDestinationKind(config));
}

export function resolvePushDestinationKind(config: Partial<Config>): PushDestinationKind {
  const kind = resolveDestinationKind(config);
  if (!isPushDestinationKind(kind)) {
    throw new Error(`The configured destination (${kind}) is not a push target.`);
  }
  return kind;
}

/** The destination without the token, for comparisons and messages. */
export function resolveDestinationIdentity(config: Partial<Config> | null | undefined): RepositoryDestination {
  const provider = resolveDestinationKind(config);
  return { provider, url: normalizeDestinationBaseUrl(config?.giteaConfig?.url, provider) };
}

/** Build the connection for a config. The token is passed in decrypted or read from the config. */
export function resolveDestinationConnection(
  config: Partial<Config>,
  { token }: { token?: string } = {}
): DestinationConnection {
  const identity = resolveDestinationIdentity(config);
  return {
    ...identity,
    username: config.giteaConfig?.defaultOwner ?? "",
    token: token ?? (config.giteaConfig?.token ? getDecryptedGiteaToken(config as Config) : ""),
    organization: config.giteaConfig?.organization || undefined,
  };
}

/** The push target adapter for a config whose destination is GitHub or GitLab. */
export function createPushTargetFromConfig(config: Partial<Config>): PushTarget {
  const kind = resolvePushDestinationKind(config);
  const connection = resolveDestinationConnection(config);
  if (!connection.token) {
    throw new Error(`A ${kind === "gitlab" ? "GitLab" : "GitHub"} token is required to push mirrors.`);
  }
  return createPushTarget(kind, {
    url: connection.url,
    username: connection.username,
    token: connection.token,
  });
}

/**
 * Refuse to touch a repository whose mirror lives on a different host.
 *
 * The mirror image of assertRepositoryMatchesConfiguredSource: after the
 * destination was switched, a row still pointing at the old server must not
 * be pushed to, synced on or deleted from the new one with the new token.
 */
export function assertRepositoryMatchesConfiguredDestination({
  repository,
  config,
}: {
  repository: Pick<Repository, "fullName"> & RepositoryDestinationFields;
  config: Partial<Config>;
}): void {
  const destination = resolveDestinationIdentity(config);
  if (isRepositoryOnConfiguredDestination(repository, destination)) return;

  throw new Error(
    `Repository ${repository.fullName} is mirrored to ${describeDestination(
      getRepositoryDestination(repository)
    )} but the configured destination is ${describeDestination(destination)}. ` +
      "Switch the destination back, or remove the repository and mirror it again."
  );
}
