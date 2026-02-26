import type { GitRepo } from "@/types/Repository";

export function isMirrorableGitHubRepo(repo: Pick<GitRepo, "isDisabled">): boolean {
  return repo.isDisabled !== true;
}

