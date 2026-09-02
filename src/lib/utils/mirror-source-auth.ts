import type { SourceProviderKind } from "@/lib/source-providers/kinds";

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

interface BuildSourceAuthPayloadParams {
  provider: SourceProviderKind;
  token?: string | null;
  /** The account the token belongs to. */
  username?: string | null;
  repositoryOwner?: string | null;
}

const GITLAB_AUTH_USERNAME = "oauth2";
const DEFAULT_GITEA_AUTH_USERNAME = "token";

/**
 * Build the clone credentials Gitea stores for a pull mirror, per source host.
 *
 * - GitHub: account name plus the token as password.
 * - GitLab: the documented "oauth2" username plus a personal access token.
 * - Gitea and Forgejo: any username plus the token as password.
 *
 * Returns an empty object when no token is available so callers can
 * Object.assign the result unconditionally.
 */
export function buildSourceAuthPayload({
  provider,
  token,
  username,
  repositoryOwner,
}: BuildSourceAuthPayloadParams): GithubSourceAuthPayloadOrEmpty {
  const normalizedToken = normalize(token);
  if (!normalizedToken) {
    return {};
  }

  switch (provider) {
    case "gitlab":
      return {
        auth_username: GITLAB_AUTH_USERNAME,
        auth_password: normalizedToken,
        auth_token: normalizedToken,
      };
    case "gitea":
      return {
        auth_username:
          normalize(username) || normalize(repositoryOwner) || DEFAULT_GITEA_AUTH_USERNAME,
        auth_password: normalizedToken,
        auth_token: normalizedToken,
      };
    case "github":
    default:
      return buildGithubSourceAuthPayload({
        token: normalizedToken,
        githubOwner: username,
        repositoryOwner,
      });
  }
}
