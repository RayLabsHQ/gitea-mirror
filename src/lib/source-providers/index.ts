/**
 * Source providers: where repositories come from.
 *
 * The configuration card picks one provider per user. Everything that talks
 * to the source host (discovery, existence checks, clone credentials) goes
 * through the SourceProvider built here, so the mirror pipeline does not need
 * to know which host it is dealing with.
 */
import type { Config, Repository } from "@/lib/db/schema";
import { getDecryptedGitHubToken } from "@/lib/utils/config-encryption";
import { GiteaSourceProvider } from "./gitea-source";
import { GitHubSourceProvider } from "./github-source";
import { GitLabSourceProvider } from "./gitlab";
import {
  describeSource,
  getRepositorySource,
  isRepositoryFromConfiguredSource,
  normalizeSourceProviderKind,
  normalizeSourceUrl,
  type RepositorySourceFields,
  type SourceProviderKind,
} from "./kinds";
import type { SourceConnection, SourceProvider } from "./types";

export * from "./kinds";
export type * from "./types";
export { SourceApiError, isSourceNotFound } from "./http";

/** The provider kind a config selects, defaulting to GitHub. */
export function resolveSourceProviderKind(
  config: Partial<Config> | null | undefined
): SourceProviderKind {
  return normalizeSourceProviderKind(config?.githubConfig?.provider);
}

/** Build the connection details for a config. The token is passed in decrypted. */
export function resolveSourceConnection(
  config: Partial<Config>,
  { token = "", userId }: { token?: string; userId?: string } = {}
): SourceConnection {
  const provider = resolveSourceProviderKind(config);
  return {
    provider,
    url: normalizeSourceUrl(config.githubConfig?.url, provider),
    username: config.githubConfig?.owner ?? "",
    token,
    userId: userId ?? config.userId,
  };
}

export function createSourceProvider(connection: SourceConnection): SourceProvider {
  switch (connection.provider) {
    case "gitlab":
      return new GitLabSourceProvider(connection);
    case "gitea":
      return new GiteaSourceProvider(connection);
    case "github":
    default:
      return new GitHubSourceProvider(connection);
  }
}

/** Build the provider for a stored config, decrypting the token. */
export function createSourceProviderFromConfig(
  config: Partial<Config>,
  { userId }: { userId?: string } = {}
): SourceProvider {
  const token = config.githubConfig?.token ? getDecryptedGitHubToken(config as Config) : "";
  return createSourceProvider(resolveSourceConnection(config, { token, userId }));
}

/**
 * Refuse to mirror a repository with credentials for a different host.
 *
 * A repository imported from GitHub must not be sent to Gitea with the GitLab
 * token that is configured now: the token would leak to the wrong host and
 * the fetch would fail anyway.
 */
export function assertRepositoryMatchesConfiguredSource({
  repository,
  config,
}: {
  repository: Pick<Repository, "fullName"> & RepositorySourceFields;
  config: Partial<Config>;
}): void {
  const connection = resolveSourceConnection(config);
  if (isRepositoryFromConfiguredSource(repository, connection)) return;

  throw new Error(
    `Repository ${repository.fullName} was imported from ${describeSource(
      getRepositorySource(repository)
    )} but the configured source is ${describeSource(connection)}. ` +
      "Switch the source back, or remove the repository and add it again from the current source."
  );
}
