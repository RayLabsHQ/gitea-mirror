import { sign } from "jsonwebtoken";
import { createHash } from "node:crypto";

export interface GitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
}

const PREFIX = "github-app:v1:";

export function encodeGitHubAppCredentials(credentials: GitHubAppCredentials): string {
  if (!/^\d+$/.test(credentials.appId) || !/^\d+$/.test(credentials.installationId) ||
      !credentials.privateKey.includes("-----BEGIN") || !credentials.privateKey.includes("PRIVATE KEY-----")) {
    throw new Error("A GitHub App ID, installation ID, and PEM private key are required.");
  }
  return PREFIX + JSON.stringify(credentials);
}

export function parseGitHubAppCredentials(value: string): GitHubAppCredentials | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const credentials = JSON.parse(value.slice(PREFIX.length));
    if (typeof credentials.appId === "string" && typeof credentials.installationId === "string" &&
        typeof credentials.privateKey === "string") {
      encodeGitHubAppCredentials(credentials);
      return credentials;
    }
  } catch {
    // Invalid stored credentials should never be used as an access token.
  }
  throw new Error("Invalid stored GitHub App credentials.");
}

const installationTokens = new Map<string, { token: string; expiresAt: number }>();

export async function resolveGitHubAccessToken(value: string, apiBaseUrl = "https://api.github.com"): Promise<string> {
  const credentials = parseGitHubAppCredentials(value);
  if (!credentials) return value;

  const cacheKey = createHash("sha256").update(`${apiBaseUrl}:${credentials.appId}:${credentials.installationId}:${credentials.privateKey}`).digest("hex");
  const cached = installationTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const jwt = sign({}, credentials.privateKey, {
    algorithm: "RS256",
    issuer: credentials.appId,
    expiresIn: "9m",
  });
  const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/app/installations/${credentials.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub App installation token request failed (${response.status}).`);
  const result = await response.json() as { token?: string; expires_at?: string };
  if (!result.token || !result.expires_at || !Number.isFinite(Date.parse(result.expires_at))) {
    throw new Error("GitHub App returned an invalid installation token.");
  }
  installationTokens.set(cacheKey, { token: result.token, expiresAt: Date.parse(result.expires_at) });
  return result.token;
}