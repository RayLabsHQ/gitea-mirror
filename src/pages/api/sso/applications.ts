import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { auth } from "@/lib/auth";
import { db, oauthAccessTokens, oauthClients, oauthConsents, oauthRefreshTokens } from "@/lib/db";
import { oauthClientResources } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isInstanceOwner, ownerOnlyResponse } from "@/lib/instance-owner";
import { applicationTypeOf, redirectUriProblem, type ApplicationType } from "@/lib/oauth-redirect-rules";

// Backward-compatible OAuth application management API, for the instance
// owner only (anyone signed in may look up one application by clientId).
//
// Migrated from the deprecated `oidc-provider` plugin to
// `@better-auth/oauth-provider`. Clients live in the `oauth_clients` table.
// Creating one goes through the plugin, which generates and hashes the
// client secret. Changes and deletes are written to the table here: the
// plugin only lets the account that created an application change or delete
// it, and the owner has to be able to remove one another account made.
// Reads are mapped back to the legacy response shape (`redirectURLs` as a
// comma-separated string) so existing consumers, notably the consent page,
// keep working.

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

/**
 * The plugin refuses bad input by throwing an APIError (400 with an
 * error_description). Pass that on instead of a 500 that hides the reason.
 */
function authApiErrorResponse(error: unknown): Response | null {
  const candidate = error as { name?: string; statusCode?: number; body?: { error_description?: string; message?: string } } | null;
  if (candidate?.name !== "APIError" || typeof candidate.statusCode !== "number") return null;
  if (candidate.statusCode < 400 || candidate.statusCode >= 500) return null;
  const reason = candidate.body?.error_description || candidate.body?.message || "The request was refused";
  return jsonError(candidate.statusCode, reason);
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Map a new oauth_clients row onto the legacy application response shape.
function toLegacyApplication(row: typeof oauthClients.$inferSelect) {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name ?? "",
    redirectURLs: parseRedirectUris(row.redirectUris).join(","),
    // better-auth 1.7 stores the OAuth application type in application_type;
    // rows registered on 1.6 still carry it in the legacy type column.
    type: row.applicationType ?? row.type ?? "web",
    disabled: row.disabled ?? false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Never expose the (hashed) client secret in list responses
    clientSecret: undefined,
  };
}

// GET /api/sso/applications - List all OAuth clients (instance owner only).
// GET /api/sso/applications?clientId=<id> - The one client the consent page
// asks about, as a list of zero or one, for any signed-in user: whoever is
// approving a sign-in needs its name and redirect addresses.
export async function GET(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const clientId = new URL(context.request.url).searchParams.get("clientId");
    if (!clientId && !(await isInstanceOwner(user.id))) return ownerOnlyResponse();

    const rows = clientId
      ? await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1)
      : await db.select().from(oauthClients);
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
    const { user, response } = await requireAuth(context);
    if (response) return response;
    if (!(await isInstanceOwner(user.id))) return ownerOnlyResponse();

    const body = await context.request.json();
    const { name, redirectURLs, type } = body;
    // Anything but "native" has always meant a web application here.
    const applicationType: ApplicationType = type === "native" ? "native" : "web";

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
    for (const uri of redirect_uris) {
      const problem = redirectUriProblem(String(uri), applicationType);
      if (problem) return jsonError(400, problem);
    }

    // Delegate to the OAuth provider plugin so the client_id / client_secret
    // are generated and the secret is stored using the plugin's hashing.
    const created = await auth.api.createOAuthClient({
      headers: context.request.headers,
      body: {
        client_name: name,
        redirect_uris,
        // 1.7 renamed the registration field and narrowed it to web or native.
        application_type: applicationType,
      },
    });

    // The plugin returns RFC-style snake_case fields. Surface them plus the
    // one-time client_secret (only returned here, never again).
    return new Response(JSON.stringify(created), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return authApiErrorResponse(error) ?? createSecureErrorResponse(error, "SSO applications API");
  }
}

// PUT /api/sso/applications?id=<clientId> - Change an OAuth client's name,
// redirect URLs or disabled flag. Works on any client, including one another
// account created before only the owner could.
export async function PUT(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;
    if (!(await isInstanceOwner(user.id))) return ownerOnlyResponse();

    const clientId = new URL(context.request.url).searchParams.get("id");
    if (!clientId) return jsonError(400, "Client ID is required");

    const [existing] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    if (!existing) return jsonError(404, "Application not found");

    const body = await context.request.json();
    const { name, redirectURLs, disabled } = body ?? {};
    const updates: Partial<typeof oauthClients.$inferInsert> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) return jsonError(400, "Name cannot be empty");
      updates.name = name.trim();
    }
    if (disabled !== undefined) {
      if (typeof disabled !== "boolean") return jsonError(400, "disabled must be true or false");
      updates.disabled = disabled;
    }
    if (redirectURLs !== undefined) {
      const uris = (Array.isArray(redirectURLs) ? redirectURLs : String(redirectURLs).split(","))
        .map((uri: unknown) => String(uri).trim())
        .filter(Boolean);
      if (uris.length === 0) return jsonError(400, "At least one redirect URL is required");
      // An application registered before better-auth 1.7 can hold a URL the
      // current rules refuse (http://localhost on a web app, say). It keeps
      // working, so editing the application must not force it out.
      const stored = new Set(parseRedirectUris(existing.redirectUris));
      const applicationType = applicationTypeOf(existing);
      for (const uri of uris) {
        if (stored.has(uri)) continue;
        const problem = redirectUriProblem(uri, applicationType);
        if (problem) return jsonError(400, problem);
      }
      updates.redirectUris = JSON.stringify(uris);
    }
    if (Object.keys(updates).length === 0) {
      return jsonError(400, "Nothing to change: send name, redirectURLs or disabled");
    }

    updates.updatedAt = new Date();
    await db.update(oauthClients).set(updates).where(eq(oauthClients.clientId, clientId));
    const [updated] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);

    return new Response(JSON.stringify(toLegacyApplication(updated)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO applications API");
  }
}

// DELETE /api/sso/applications?id=<clientId> - Delete an OAuth client, with
// the tokens it was given and the approvals people gave it. The plugin's own
// delete leaves the tokens, so an application removed for being unwanted
// could keep using them until they expire.
export async function DELETE(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;
    if (!(await isInstanceOwner(user.id))) return ownerOnlyResponse();

    const clientId = new URL(context.request.url).searchParams.get("id");
    if (!clientId) return jsonError(400, "Client ID is required");

    const [existing] = await db
      .select({ id: oauthClients.id })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    if (!existing) return jsonError(404, "Application not found");

    await db.transaction(async (tx) => {
      await tx.delete(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, clientId));
      await tx.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.clientId, clientId));
      await tx.delete(oauthConsents).where(eq(oauthConsents.clientId, clientId));
      await tx.delete(oauthClientResources).where(eq(oauthClientResources.clientId, clientId));
      await tx.delete(oauthClients).where(eq(oauthClients.clientId, clientId));
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO applications API");
  }
}
