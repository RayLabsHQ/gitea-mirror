/**
 * Octokit for a GitHub App installation source.
 *
 * The client is the throttled public one with an installation token added to
 * every request. Tokens come from resolveGitHubAccessToken, which caches them
 * until shortly before they expire, so long runs keep working past the hour.
 *
 * Installation tokens authenticate every request, so this client also gets the
 * ETag cache createGitHubClient has: unchanged GETs come back as 304s, which
 * do not count against the installation's rate limit.
 */
import type { Octokit } from "@octokit/rest";
import { createPublicGitHubClient } from "@/lib/github";
import { conditionalRequestTokenScope } from "@/lib/github-conditional-requests";
import { resolveGitHubAccessToken } from "@/lib/github-app-credentials";

export function createGitHubAppClient(
  credential: string,
  { userId, apiBaseUrl }: { userId?: string; apiBaseUrl?: string } = {}
): Octokit {
  const octokit = createPublicGitHubClient(
    apiBaseUrl,
    userId,
    // Scoped per user, like createGitHubClient. Without one, an installation
    // still has a stable identity: the credential hash keeps its cache entries
    // apart from any other App without putting the secret in a cache key.
    userId ?? conditionalRequestTokenScope(credential)
  );
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
