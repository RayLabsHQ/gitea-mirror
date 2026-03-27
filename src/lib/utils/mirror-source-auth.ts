interface BuildGithubSourceAuthPayloadParams {
  token?: string | null;
  githubOwner?: string | null;
  githubUsername?: string | null;
  repositoryOwner?: string | null;
}

export interface GithubSourceAuthPayload {
  auth_username: string;
  auth_password: string;
  auth_token: string;
}

const DEFAULT_GITHUB_AUTH_USERNAME = "x-access-token";

function normalize(value?: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build source credentials for private GitHub repository mirroring.
 * GitHub expects username + token-as-password over HTTPS (not the GitLab-style "oauth2" username).
 */
export function buildGithubSourceAuthPayload({
  token,
  githubOwner,
  githubUsername,
  repositoryOwner,
}: BuildGithubSourceAuthPayloadParams): GithubSourceAuthPayload {
  const normalizedToken = normalize(token);
  if (!normalizedToken) {
    throw new Error("GitHub token is required to mirror private repositories.");
  }

  const authUsername =
    normalize(githubOwner) ||
    normalize(githubUsername) ||
    normalize(repositoryOwner) ||
    DEFAULT_GITHUB_AUTH_USERNAME;

  return {
    auth_username: authUsername,
    auth_password: normalizedToken,
    auth_token: normalizedToken,
  };
}
