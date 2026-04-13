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

export type GithubSourceAuthPayloadOrEmpty = GithubSourceAuthPayload | Record<string, never>;

const DEFAULT_GITHUB_AUTH_USERNAME = "x-access-token";

function normalize(value?: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build source credentials for GitHub repository mirroring.
 * GitHub expects username + token-as-password over HTTPS (not the GitLab-style "oauth2" username).
 * Returns an empty object when no token is available, allowing callers to use it unconditionally.
 */
export function buildGithubSourceAuthPayload({
  token,
  githubOwner,
  githubUsername,
  repositoryOwner,
}: BuildGithubSourceAuthPayloadParams): GithubSourceAuthPayloadOrEmpty {
  const normalizedToken = normalize(token);
  if (!normalizedToken) {
    return {};
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
