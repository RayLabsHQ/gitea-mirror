import { createLocalJWKSet, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { withBase } from "@/lib/base-path";
import { db, jwkss, oauthClients, sessions } from "@/lib/db";

export const MCP_READ_SCOPE = "mirror:read";
export const MCP_SYNC_SCOPE = "mirror:sync";
export const MCP_SETTINGS_SCOPE = "mirror:settings";

export function getMcpResourceUrl(): string {
  const origin = new URL(process.env.BETTER_AUTH_URL || "http://localhost:4321").origin;
  return `${origin}${withBase("/api/mcp")}`;
}

export function getMcpIssuerUrl(): string {
  const origin = new URL(process.env.BETTER_AUTH_URL || "http://localhost:4321").origin;
  return new URL(withBase("/api/auth"), origin).toString();
}

export interface McpPrincipal {
  userId: string;
  scopes: string[];
}

export interface McpTokenClaims {
  sub?: unknown;
  aud?: unknown;
  scope?: unknown;
  exp?: unknown;
  sid?: unknown;
  azp?: unknown;
}

export function resolveMcpPrincipal(
  claims: McpTokenClaims | undefined,
  now = Date.now(),
): McpPrincipal | null {
  if (
    typeof claims?.sub !== "string" ||
    typeof claims.sid !== "string" ||
    typeof claims.azp !== "string" ||
    typeof claims.exp !== "number" ||
    claims.exp <= Math.floor(now / 1000)
  ) return null;

  const audiences = typeof claims.aud === "string"
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((audience) => typeof audience === "string")
      ? claims.aud
      : [];
  if (!audiences.includes(getMcpResourceUrl()) || typeof claims.scope !== "string") return null;

  const grantedScopes = claims.scope.split(/\s+/).filter((scope) =>
    scope === MCP_READ_SCOPE || scope === MCP_SYNC_SCOPE || scope === MCP_SETTINGS_SCOPE
  );
  if (grantedScopes.length === 0) return null;

  return { userId: claims.sub, scopes: grantedScopes };
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
  if (match[1].split(".").length !== 3) return unauthorized();

  const keyRows = await db.select({
    id: jwkss.id,
    publicKey: jwkss.publicKey,
    alg: jwkss.alg,
    expiresAt: jwkss.expiresAt,
  }).from(jwkss).limit(100);
  const keys = keyRows.flatMap((row) => {
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return [];
    try {
      const key = JSON.parse(row.publicKey);
      if (!key || typeof key !== "object" || Array.isArray(key)) return [];
      return [{
        ...key,
        kid: row.id,
        ...(row.alg ? { alg: row.alg } : {}),
        use: "sig",
      }];
    } catch {
      return [];
    }
  });
  if (keys.length === 0) return unauthorized();

  let claims: McpTokenClaims;
  try {
    const jwks = createLocalJWKSet({ keys });
    ({ payload: claims } = await jwtVerify(match[1], jwks, {
      issuer: getMcpIssuerUrl(),
      audience: getMcpResourceUrl(),
    }));
  } catch {
    return unauthorized();
  }

  const principal = resolveMcpPrincipal(claims);
  if (!principal) return unauthorized();

  const [client] = await db.select({ disabled: oauthClients.disabled })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, claims.azp as string))
    .limit(1);
  if (!client || client.disabled) return unauthorized();

  const [session] = await db.select({
    userId: sessions.userId,
    expiresAt: sessions.expiresAt,
  }).from(sessions).where(and(
    eq(sessions.id, claims.sid as string),
    eq(sessions.userId, principal.userId),
  )).limit(1);
  if (!session || session.expiresAt.getTime() <= Date.now()) return unauthorized();

  return principal;
}

export { unauthorized as mcpUnauthorizedResponse };
