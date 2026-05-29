import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { auth } from "@/lib/auth";
import { db, oauthClients } from "@/lib/db";
import { eq } from "drizzle-orm";

// Backward-compatible OAuth application management API.
//
// Migrated from the deprecated `oidc-provider` plugin to
// `@better-auth/oauth-provider`. Clients now live in the `oauth_clients`
// table and are managed by the plugin (which generates and hashes the
// client secret), so mutations delegate to `auth.api.*OAuthClient`. Reads
// are served straight from the table and mapped back to the legacy response
// shape (`redirectURLs` as a comma-separated string) so existing consumers
// — notably the consent page — keep working.

// `redirectUris` is stored by the adapter as a JSON-encoded string[].
function parseRedirectUris(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Legacy comma-separated fallback
      return value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

// Map a new oauth_clients row onto the legacy application response shape.
function toLegacyApplication(row: typeof oauthClients.$inferSelect) {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name ?? "",
    redirectURLs: parseRedirectUris(row.redirectUris).join(","),
    type: row.type ?? "web",
    disabled: row.disabled ?? false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Never expose the (hashed) client secret in list responses
    clientSecret: undefined,
  };
}

// GET /api/sso/applications - List all OAuth clients
export async function GET(context: APIContext) {
  try {
    const { response } = await requireAuth(context);
    if (response) return response;

    const rows = await db.select().from(oauthClients);
    const sanitized = rows.map(toLegacyApplication);

    return new Response(JSON.stringify(sanitized), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO applications API");
  }
}

// POST /api/sso/applications - Register a new OAuth client
export async function POST(context: APIContext) {
  try {
    const { response } = await requireAuth(context);
    if (response) return response;

    const body = await context.request.json();
    const { name, redirectURLs, type = "web", metadata } = body;

    // Validate required fields
    if (!name || !redirectURLs || redirectURLs.length === 0) {
      return new Response(
        JSON.stringify({ error: "Name and at least one redirect URL are required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const redirect_uris = Array.isArray(redirectURLs)
      ? redirectURLs
      : String(redirectURLs)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    // Delegate to the OAuth provider plugin so the client_id / client_secret
    // are generated and the secret is stored using the plugin's hashing.
    const created = await auth.api.createOAuthClient({
      headers: context.request.headers,
      body: {
        client_name: name,
        redirect_uris,
        type,
      },
    });

    // The plugin returns RFC-style snake_case fields. Surface them plus the
    // one-time client_secret (only returned here, never again).
    return new Response(JSON.stringify(created), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO applications API");
  }
}

// PUT /api/sso/applications?id=<clientId> - Update an OAuth client
export async function PUT(context: APIContext) {
  try {
    const { response } = await requireAuth(context);
    if (response) return response;

    const url = new URL(context.request.url);
    // Accept the OAuth client_id either from the query string or the path.
    const clientId = url.searchParams.get("id") || url.pathname.split("/").pop();

    if (!clientId) {
      return new Response(
        JSON.stringify({ error: "Client ID is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const body = await context.request.json();
    const { name, redirectURLs, disabled } = body;

    const updateBody: Record<string, unknown> = { client_id: clientId };
    if (name !== undefined) updateBody.client_name = name;
    if (disabled !== undefined) updateBody.disabled = disabled;
    if (redirectURLs !== undefined) {
      updateBody.redirect_uris = Array.isArray(redirectURLs)
        ? redirectURLs
        : String(redirectURLs)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }

    const updated = await auth.api.updateOAuthClient({
      headers: context.request.headers,
      body: updateBody as any,
    });

    return new Response(JSON.stringify(updated), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO applications API");
  }
}

// DELETE /api/sso/applications?id=<clientId> - Delete an OAuth client
export async function DELETE(context: APIContext) {
  try {
    const { response } = await requireAuth(context);
    if (response) return response;

    const url = new URL(context.request.url);
    const clientId = url.searchParams.get("id");

    if (!clientId) {
      return new Response(
        JSON.stringify({ error: "Client ID is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Ensure the client exists so we can return a 404 (the plugin endpoint
    // may otherwise succeed silently).
    const existing = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);

    if (existing.length === 0) {
      return new Response(JSON.stringify({ error: "Application not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    await auth.api.deleteOAuthClient({
      headers: context.request.headers,
      body: { client_id: clientId },
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO applications API");
  }
}
