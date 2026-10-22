/**
 * Replacing the source credentials a Gitea pull mirror stores.
 *
 * GitHub App installation tokens expire after an hour, so an App-backed pull
 * mirror only keeps pulling if its credentials are replaced before each sync.
 * Gitea accepts mirror_username, mirror_password and mirror_token on
 * PATCH /repos/{owner}/{repo} from 1.27.0 (and on the 28+ line). Gitea 1.26
 * and earlier, and Forgejo, drop those fields without an error, so the
 * destination version is checked before an App-backed repository is
 * migrated or synced.
 */
import type { Config } from "@/types/config";
import { resolveDestinationKind } from "./destination-connection";
import { httpGet, httpPatch } from "./http-client";

const VERSION_CACHE_MS = 10 * 60 * 1000;
const versionCache = new Map<string, { version: string; fetchedAt: number }>();

/** True when a Gitea version string accepts mirror credential updates. */
export function supportsMirrorCredentialUpdate(version: string): boolean {
  // Forgejo reports e.g. "11.0.3+gitea-1.22.0".
  if (/\+gitea-/i.test(version) || /forgejo/i.test(version)) return false;
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 27);
}

async function destinationVersion(baseUrl: string, token: string): Promise<string> {
  const cached = versionCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < VERSION_CACHE_MS) return cached.version;
  const response = await httpGet<{ version?: string }>(`${baseUrl}/api/v1/version`, {
    Authorization: `token ${token}`,
  });
  const version = String(response.data?.version ?? "");
  versionCache.set(baseUrl, { version, fetchedAt: Date.now() });
  return version;
}

/**
 * Throws when the destination cannot refresh mirror credentials, before any
 * mirror is created that would stop pulling once its first token expires.
 */
export async function assertMirrorCredentialUpdateSupported(
  config: Partial<Config>,
  giteaToken: string
): Promise<void> {
  const unsupported =
    "GitHub App sources need Gitea 1.27 or later as the destination, because installation tokens expire " +
    "after an hour and older Gitea and Forgejo cannot update a mirror's credentials through the API. " +
    "Use a personal access token for this source instead.";
  if (resolveDestinationKind(config) === "forgejo") throw new Error(unsupported);
  const baseUrl = (config.giteaConfig?.url ?? "").replace(/\/+$/, "");
  const version = await destinationVersion(baseUrl, giteaToken);
  if (!supportsMirrorCredentialUpdate(version)) {
    throw new Error(`${unsupported} (destination reports version ${version || "unknown"})`);
  }
}

/** Store a fresh installation token on the mirror and keep Gitea's own schedule off. */
export async function refreshMirrorCredentials({
  config,
  giteaToken,
  owner,
  repo,
  accessToken,
}: {
  config: Partial<Config>;
  giteaToken: string;
  owner: string;
  repo: string;
  accessToken: string;
}): Promise<void> {
  await assertMirrorCredentialUpdateSupported(config, giteaToken);
  const baseUrl = (config.giteaConfig?.url ?? "").replace(/\/+$/, "");
  await httpPatch(
    `${baseUrl}/api/v1/repos/${owner}/${repo}`,
    {
      mirror_username: "x-access-token",
      mirror_token: accessToken,
      // Gitea's own pulls would run with an expired token; this app's
      // scheduler refreshes the token and triggers each sync instead.
      mirror_interval: "0h",
    },
    { Authorization: `token ${giteaToken}` }
  );
}

/** Test hook: forget cached destination versions. */
export function clearDestinationVersionCache(): void {
  versionCache.clear();
}
