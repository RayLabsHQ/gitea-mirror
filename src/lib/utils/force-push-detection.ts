/**
 * Force-push detection module.
 *
 * Compares branch SHAs between a Gitea mirror and GitHub source to detect
 * branches that were deleted, rewritten, or force-pushed.
 *
 * **Fail-open**: If detection itself fails (API errors, rate limits, etc.),
 * the result indicates no force-push so sync proceeds normally. Detection
 * should never block sync due to its own failure.
 */

import type { Octokit } from "@octokit/rest";
import { httpGet, HttpError } from "@/lib/http-client";

// ---- Types ----

export interface BranchInfo {
  name: string;
  sha: string;
}

export type ForcePushReason = "deleted" | "diverged" | "non-fast-forward";

export interface AffectedBranch {
  name: string;
  reason: ForcePushReason;
  giteaSha: string;
  githubSha: string | null; // null when branch was deleted
}

export interface ForcePushDetectionResult {
  detected: boolean;
  affectedBranches: AffectedBranch[];
  /** True when detection could not run (API error, etc.) */
  skipped: boolean;
  skipReason?: string;
}

const NO_FORCE_PUSH: ForcePushDetectionResult = {
  detected: false,
  affectedBranches: [],
  skipped: false,
};

function skippedResult(reason: string): ForcePushDetectionResult {
  return {
    detected: false,
    affectedBranches: [],
    skipped: true,
    skipReason: reason,
  };
}

// ---- Branch fetching ----

/**
 * Fetch all branches from a Gitea repository (paginated).
 */
export async function fetchGiteaBranches({
  giteaUrl,
  giteaToken,
  owner,
  repo,
}: {
  giteaUrl: string;
  giteaToken: string;
  owner: string;
  repo: string;
}): Promise<BranchInfo[]> {
  const branches: BranchInfo[] = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    const url = `${giteaUrl}/api/v1/repos/${owner}/${repo}/branches?page=${page}&limit=${perPage}`;
    const response = await httpGet<Array<{ name: string; commit: { id: string } }>>(
      url,
      { Authorization: `token ${giteaToken}` },
    );

    if (!Array.isArray(response.data) || response.data.length === 0) break;

    for (const b of response.data) {
      branches.push({ name: b.name, sha: b.commit.id });
    }

    if (response.data.length < perPage) break;
    page++;
  }

  return branches;
}

/**
 * Fetch all branches from a GitHub repository (paginated via Octokit).
 */
export async function fetchGitHubBranches({
  octokit,
  owner,
  repo,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
}): Promise<BranchInfo[]> {
  const data = await octokit.paginate(octokit.repos.listBranches, {
    owner,
    repo,
    per_page: 100,
  });

  return data.map((b) => ({ name: b.name, sha: b.commit.sha }));
}

/**
 * Check whether the transition from `baseSha` to `headSha` on the same branch
 * is a fast-forward (i.e. `baseSha` is an ancestor of `headSha`).
 *
 * Returns `true` when the change is safe (fast-forward) and `false` when it
 * is a confirmed force-push (404 = old SHA garbage-collected from GitHub).
 *
 * Throws on transient errors (rate limits, network issues) so the caller
 * can decide how to handle them (fail-open: skip that branch).
 */
export async function checkAncestry({
  octokit,
  owner,
  repo,
  baseSha,
  headSha,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
}): Promise<boolean> {
  try {
    const { data } = await octokit.repos.compareCommits({
      owner,
      repo,
      base: baseSha,
      head: headSha,
    });
    // "ahead" means headSha is strictly ahead of baseSha → fast-forward.
    // "behind" or "diverged" means the branch was rewritten.
    return data.status === "ahead" || data.status === "identical";
  } catch (error: any) {
    // 404 / 422 = old SHA no longer exists on GitHub → confirmed force-push.
    if (error?.status === 404 || error?.status === 422) {
      return false;
    }
    // Any other error (rate limit, network) → rethrow so caller can
    // handle it as fail-open (skip branch) rather than false-positive.
    throw error;
  }
}

// ---- Main detection ----

/**
 * Compare branch SHAs between Gitea and GitHub to detect force-pushes.
 *
 * The function is intentionally fail-open: any error during detection returns
 * a "skipped" result so that sync can proceed normally.
 */
export async function detectForcePush({
  giteaUrl,
  giteaToken,
  giteaOwner,
  giteaRepo,
  octokit,
  githubOwner,
  githubRepo,
  _deps,
}: {
  giteaUrl: string;
  giteaToken: string;
  giteaOwner: string;
  giteaRepo: string;
  octokit: Octokit;
  githubOwner: string;
  githubRepo: string;
  /** @internal — test-only dependency injection */
  _deps?: {
    fetchGiteaBranches: typeof fetchGiteaBranches;
    fetchGitHubBranches: typeof fetchGitHubBranches;
    checkAncestry: typeof checkAncestry;
  };
}): Promise<ForcePushDetectionResult> {
  const deps = _deps ?? { fetchGiteaBranches, fetchGitHubBranches, checkAncestry };

  // 1. Fetch Gitea branches
  let giteaBranches: BranchInfo[];
  try {
    giteaBranches = await deps.fetchGiteaBranches({
      giteaUrl,
      giteaToken,
      owner: giteaOwner,
      repo: giteaRepo,
    });
  } catch (error) {
    // Gitea 404 = repo not yet mirrored, skip detection
    if (error instanceof HttpError && error.status === 404) {
      return skippedResult("Gitea repository not found (first mirror?)");
    }
    return skippedResult(
      `Failed to fetch Gitea branches: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // First-time mirror: no Gitea branches → nothing to compare
  if (giteaBranches.length === 0) {
    return skippedResult("No Gitea branches found (first mirror?)");
  }

  // 2. Fetch GitHub branches
  let githubBranches: BranchInfo[];
  try {
    githubBranches = await deps.fetchGitHubBranches({
      octokit,
      owner: githubOwner,
      repo: githubRepo,
    });
  } catch (error) {
    return skippedResult(
      `Failed to fetch GitHub branches: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const githubBranchMap = new Map(githubBranches.map((b) => [b.name, b.sha]));

  // 3. Compare each Gitea branch against GitHub
  const affected: AffectedBranch[] = [];

  for (const giteaBranch of giteaBranches) {
    const githubSha = githubBranchMap.get(giteaBranch.name);

    if (githubSha === undefined) {
      // Branch was deleted on GitHub
      affected.push({
        name: giteaBranch.name,
        reason: "deleted",
        giteaSha: giteaBranch.sha,
        githubSha: null,
      });
      continue;
    }

    // Same SHA → no change
    if (githubSha === giteaBranch.sha) continue;

    // SHAs differ → check if it's a fast-forward
    try {
      const isFastForward = await deps.checkAncestry({
        octokit,
        owner: githubOwner,
        repo: githubRepo,
        baseSha: giteaBranch.sha,
        headSha: githubSha,
      });

      if (!isFastForward) {
        affected.push({
          name: giteaBranch.name,
          reason: "diverged",
          giteaSha: giteaBranch.sha,
          githubSha,
        });
      }
    } catch {
      // Individual branch check failure → skip that branch (fail-open)
      continue;
    }
  }

  if (affected.length === 0) {
    return NO_FORCE_PUSH;
  }

  return {
    detected: true,
    affectedBranches: affected,
    skipped: false,
  };
}
