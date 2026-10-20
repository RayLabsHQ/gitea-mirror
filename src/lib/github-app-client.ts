/**
 * Octokit for a GitHub App installation source.
 *
 * The client is the throttled public one with an installation token added to
 * every request. Tokens come from resolveGitHubAccessToken, which caches them
 * until shortly before they expire, so long runs keep working past the hour.
 */
import type { Octokit } from "@octokit/rest";
import { createPublicGitHubClient } from "@/lib/github";
import { resolveGitHubAccessToken } from "@/lib/github-app-credentials";

export function createGitHubAppClient(
  credential: string,
  { userId, apiBaseUrl }: { userId?: string; apiBaseUrl?: string } = {}
): Octokit {
  const octokit = createPublicGitHubClient(apiBaseUrl, userId);
  const tokenApiBaseUrl =
    apiBaseUrl || process.env.GH_API_URL || process.env.GITHUB_API_URL || "https://api.github.com";
  octokit.hook.before("request", async (options) => {
    options.headers = {
      ...options.headers,
      authorization: `token ${await resolveGitHubAccessToken(credential, tokenApiBaseUrl)}`,
    };
  });
  return octokit;
}
