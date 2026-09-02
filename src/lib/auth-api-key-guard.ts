import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { API_KEY_HEADER } from "./api-keys";

/**
 * Keeps API keys from managing API keys.
 *
 * With `enableSessionForAPIKeys` a request carrying a valid key gets a
 * session for every Better Auth endpoint, including the key endpoints
 * themselves. Left alone, a leaked key could mint a fresh key that
 * outlives the revocation of the leaked one. This plugin refuses any
 * `/api-key/*` call that arrives with the key header, so creating,
 * listing and revoking keys always needs a real sign-in.
 */

/** Endpoint paths (without the auth base path) that manage keys. */
export const API_KEY_MANAGEMENT_PATH_PREFIX = "/api-key";

export function isApiKeyManagementRequest(
  path: string | undefined,
  headers: Headers | undefined,
): boolean {
  if (!path || !headers) return false;
  const managesKeys =
    path === API_KEY_MANAGEMENT_PATH_PREFIX || path.startsWith(`${API_KEY_MANAGEMENT_PATH_PREFIX}/`);
  if (!managesKeys) return false;
  const header = headers.get(API_KEY_HEADER);
  return typeof header === "string" && header.trim() !== "";
}

export function apiKeyManagementForbidden(): APIError {
  return new APIError("FORBIDDEN", {
    message: "API keys cannot create, list or revoke API keys. Sign in to manage keys.",
    code: "API_KEY_CANNOT_MANAGE_KEYS",
  });
}

export const apiKeyGuardPlugin = () =>
  ({
    id: "api-key-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => isApiKeyManagementRequest(ctx.path, ctx.headers),
          handler: createAuthMiddleware(async () => {
            throw apiKeyManagementForbidden();
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
