import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { withBase } from "@/lib/base-path";
import { db, oauthAccessTokens } from "@/lib/db";

export const MCP_READ_SCOPE = "mirror:read";
export const MCP_SYNC_SCOPE = "mirror:sync";

export function getMcpResourceUrl(): string {
  const origin = new URL(process.env.BETTER_AUTH_URL || "http://localhost:4321").origin;
  return `${origin}${withBase("/api/mcp")}`;
}

export interface McpPrincipal {
  userId: string;
  scopes: string[];
}

export interface McpTokenRecord {
  userId: string | null;
  scopes: string;
  resources: string | null;
  expiresAt: Date | null;
}

export function resolveMcpPrincipal(
  record: McpTokenRecord | undefined,
  now = Date.now(),
): McpPrincipal | null {
  if (!record?.userId || !record.expiresAt || record.expiresAt.getTime() <= now) return null;

  let scopes: unknown;
  let resources: unknown;
  try {
    scopes = JSON.parse(record.scopes);
    resources = JSON.parse(record.resources ?? "[]");
  } catch {
    return null;
  }

  if (
    !Array.isArray(scopes) ||
    !Array.isArray(resources) ||
    !resources.includes(getMcpResourceUrl())
  ) return null;

  return { userId: record.userId, scopes: scopes.filter((scope): scope is string => typeof scope === "string") };
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${new URL(`/.well-known/oauth-protected-resource${withBase("/api/mcp")}`, getMcpResourceUrl()).toString()}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Resolve a live, resource-bound Better Auth OAuth access token. */
export async function authenticateMcpRequest(request: Request): Promise<McpPrincipal | Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) return unauthorized();

  const tokenHash = createHash("sha256").update(match[1]).digest("base64url");
  const [record] = await db.select({
    userId: oauthAccessTokens.userId,
    scopes: oauthAccessTokens.scopes,
    resources: oauthAccessTokens.resources,
    expiresAt: oauthAccessTokens.expiresAt,
  }).from(oauthAccessTokens).where(and(
    eq(oauthAccessTokens.token, tokenHash),
    isNull(oauthAccessTokens.revoked),
  )).limit(1);

  return resolveMcpPrincipal(record) ?? unauthorized();
}

export { unauthorized as mcpUnauthorizedResponse };
