import type { Config } from "@/lib/db/schema";
import type { GitRepo } from "@/types/Repository";
import type { ListRepositoriesOptions } from "./types";

/**
 * Apply the repository selection filters from the source config to a list of
 * already mapped repositories. Mirrors the rules getGithubRepositories applies
 * inline for GitHub so GitLab and Gitea sources behave the same way:
 *
 * - skipForks drops forks
 * - skipPersonalRepos drops repos the configured account owns
 * - includeCollaboratorRepos=false drops personal repos of other users
 * - includeOrganizations, when non-empty, keeps only org repos from listed orgs
 */
export function filterSourceRepositories(
  repos: GitRepo[],
  {
    config,
    options = {},
    username,
  }: {
    config: Partial<Config>;
    options?: ListRepositoriesOptions;
    username: string;
  }
): GitRepo[] {
  const includeCollab =
    options.includeCollaboratorReposOverride ??
    config.githubConfig?.includeCollaboratorRepos ??
    true;
  const skipForks = config.githubConfig?.skipForks ?? false;
  const skipPersonalRepos = config.githubConfig?.skipPersonalRepos ?? false;
  const includeOrgs = options.includeAllOrgsOverride
    ? []
    : config.githubConfig?.includeOrganizations ?? [];
  const allowedOrgs = new Set(
    includeOrgs.map((org) => org.trim().toLowerCase()).filter(Boolean)
  );
  const me = username.trim().toLowerCase();

  return repos.filter((repo) => {
    if (skipForks && repo.isForked) return false;

    const ownerKey = repo.owner.trim().toLowerCase();
    const orgKey = (repo.organization ?? "").trim().toLowerCase();
    const isOrgRepo = orgKey.length > 0;
    const isOwnRepo = !isOrgRepo && me.length > 0 && ownerKey === me;

    if (skipPersonalRepos && isOwnRepo) return false;
    if (!includeCollab && !isOrgRepo && !isOwnRepo) return false;
    if (allowedOrgs.size > 0 && isOrgRepo && !allowedOrgs.has(orgKey)) return false;

    return true;
  });
}
