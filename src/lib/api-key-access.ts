import { eq } from "drizzle-orm";
import { apikeys, db } from "./db";
import { stripBasePath } from "./base-path";
import { API_KEY_HEADER, keyAccessFromMetadata } from "./api-keys";

/**
 * Enforces read only API keys (see ApiKeyAccess in api-keys.ts). The
 * middleware asks this before every route runs, so no route needs its own
 * check.
 */

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True when a read only key is refused: any method that can change state,
 * and every Better Auth endpoint except the session lookup, since some of
 * those act on the account even on GET (the OAuth authorize endpoint).
 * The MCP endpoint takes every message as a POST but changes nothing
 * itself; its tools call the REST API with the same key, where this rule
 * refuses the writes.
 */
export function needsWriteAccess(method: string, pathname: string): boolean {
  const path = stripBasePath(pathname);
  if (path.replace(/\/+$/, "") === "/api/mcp") return false;
  if (!READ_METHODS.has(method.toUpperCase())) return true;
  const isAuthEndpoint = path === "/api/auth" || path.startsWith("/api/auth/");
  return isAuthEndpoint && path !== "/api/auth/get-session";
}

export function readOnlyKeyResponse(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: "This API key is read only. Use a key with full access to make changes.",
      code: "API_KEY_READ_ONLY",
    }),
    { status: 403, headers: { "Content-Type": "application/json" } }
  );
}

/** The key's stored metadata, null when it has none, undefined when no row matches. */
async function lookupKeyMetadata(keyId: string): Promise<unknown | undefined> {
  const [row] = await db
    .select({ metadata: apikeys.metadata })
    .from(apikeys)
    .where(eq(apikeys.id, keyId))
    .limit(1);
  return row ? row.metadata ?? null : undefined;
}

/**
 * The 403 for a read only key asking for more than a read, or null when the
 * request may go on. With enableSessionForAPIKeys the plugin builds the
 * session from the key and gives it the key's id, so the session id finds
 * the key row. A request whose key failed to resolve has no session and is
 * left to the route, which answers 401.
 */
export async function refuseReadOnlyApiKey(input: {
  request: Request;
  pathname: string;
  sessionId: string | null | undefined;
  lookupMetadata?: (keyId: string) => Promise<unknown | undefined>;
}): Promise<Response | null> {
  const header = input.request.headers.get(API_KEY_HEADER);
  if (!header?.trim() || !input.sessionId) return null;
  if (!needsWriteAccess(input.request.method, input.pathname)) return null;

  const metadata = await (input.lookupMetadata ?? lookupKeyMetadata)(input.sessionId);
  // A key session without a key row should not exist; refuse rather than
  // guess that it has full access.
  if (metadata === undefined) return readOnlyKeyResponse();
  return keyAccessFromMetadata(metadata) === "read" ? readOnlyKeyResponse() : null;
}
