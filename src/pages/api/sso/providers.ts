import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { db, ssoProviders } from "@/lib/db";
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { normalizeOidcProviderConfig, OidcConfigError, type RawOidcConfig } from "@/lib/sso/oidc-config";

/**
 * Providers are owned by the user who created them. Every read and write
 * here is scoped to the caller, and the client secret never leaves the
 * server: the API reports whether one is stored and the form keeps it by
 * sending an empty value.
 */
export function formatProviderForClient(provider: {
  oidcConfig: string | null;
  [key: string]: unknown;
}) {
  const oidcConfig = provider.oidcConfig ? JSON.parse(provider.oidcConfig) : undefined;
  if (oidcConfig && typeof oidcConfig === "object") {
    const { clientSecret, ...rest } = oidcConfig as { clientSecret?: unknown };
    return {
      ...provider,
      oidcConfig: { ...rest, hasClientSecret: typeof clientSecret === "string" && clientSecret.length > 0 },
      samlConfig: (provider as any).samlConfig ? JSON.parse((provider as any).samlConfig) : undefined,
    };
  }
  return {
    ...provider,
    oidcConfig,
    samlConfig: (provider as any).samlConfig ? JSON.parse((provider as any).samlConfig) : undefined,
  };
}

// GET /api/sso/providers - List all SSO providers
export async function GET(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const providers = await db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.userId, user.id));

    const formattedProviders = providers.map(formatProviderForClient);

    return new Response(JSON.stringify(formattedProviders), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO providers API");
  }
}

// POST /api/sso/providers - Create a new SSO provider
export async function POST(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const body = await context.request.json();
    const {
      issuer,
      domain,
      clientId,
      clientSecret,
      authorizationEndpoint,
      tokenEndpoint,
      jwksEndpoint,
      userInfoEndpoint,
      discoveryEndpoint,
      mapping,
      providerId,
      organizationId,
      scopes,
      pkce,
    } = body;

    // Validate required fields
    if (!issuer || !domain || !providerId) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Check if provider ID already exists
    const existing = await db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.providerId, providerId))
      .limit(1);

    if (existing.length > 0) {
      return new Response(
        JSON.stringify({ error: "Provider ID already exists" }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Validate issuer URL format but keep trailing slash if provided
    const trimmedIssuer = issuer.toString().trim();
    try {
      new URL(trimmedIssuer);
    } catch {
      return new Response(
        JSON.stringify({ error: `Invalid issuer URL format: ${issuer}` }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    let normalized;
    try {
      normalized = await normalizeOidcProviderConfig(trimmedIssuer, {
        clientId,
        clientSecret,
        authorizationEndpoint,
        tokenEndpoint,
        jwksEndpoint,
        userInfoEndpoint,
        discoveryEndpoint,
        scopes,
        pkce,
        mapping,
      });
    } catch (error) {
      if (error instanceof OidcConfigError) {
        return new Response(
          JSON.stringify({ error: error.message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      throw error;
    }

    const storedOidcConfig = {
      ...normalized.oidcConfig,
      mapping: normalized.mapping,
    };

    // Insert new provider
    const [newProvider] = await db
      .insert(ssoProviders)
      .values({
        id: nanoid(),
        issuer: trimmedIssuer,
        domain,
        oidcConfig: JSON.stringify(storedOidcConfig),
        userId: user.id,
        providerId,
        organizationId,
      })
      .returning();

    const formattedProvider = formatProviderForClient(newProvider);

    return new Response(JSON.stringify(formattedProvider), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO providers API");
  }
}

// PUT /api/sso/providers - Update an existing SSO provider
export async function PUT(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const url = new URL(context.request.url);
    const providerId = url.searchParams.get("id");

    if (!providerId) {
      return new Response(
        JSON.stringify({ error: "Provider ID is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const body = await context.request.json();
    const {
      issuer,
      domain,
      clientId,
      clientSecret,
      authorizationEndpoint,
      tokenEndpoint,
      jwksEndpoint,
      userInfoEndpoint,
      discoveryEndpoint,
      scopes,
      pkce,
      organizationId,
    } = body;

    // Get existing provider; another user's provider reads as not found
    const [existingProvider] = await db
      .select()
      .from(ssoProviders)
      .where(and(eq(ssoProviders.id, providerId), eq(ssoProviders.userId, user.id)))
      .limit(1);

    if (!existingProvider) {
      return new Response(
        JSON.stringify({ error: "Provider not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Parse existing config
    const existingConfig = JSON.parse(existingProvider.oidcConfig);
    const effectiveIssuer = issuer?.toString().trim() || existingProvider.issuer;

    try {
      new URL(effectiveIssuer);
    } catch {
      return new Response(
        JSON.stringify({ error: `Invalid issuer URL format: ${effectiveIssuer}` }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const mergedConfig: RawOidcConfig = {
      clientId: clientId ?? existingConfig.clientId,
      // The list endpoint never returns the secret, so the form sends an
      // empty value to keep the stored one.
      clientSecret: clientSecret ? clientSecret : existingConfig.clientSecret,
      authorizationEndpoint: authorizationEndpoint ?? existingConfig.authorizationEndpoint,
      tokenEndpoint: tokenEndpoint ?? existingConfig.tokenEndpoint,
      jwksEndpoint: jwksEndpoint ?? existingConfig.jwksEndpoint,
      userInfoEndpoint: userInfoEndpoint ?? existingConfig.userInfoEndpoint,
      discoveryEndpoint: discoveryEndpoint ?? existingConfig.discoveryEndpoint,
      scopes: scopes ?? existingConfig.scopes,
      pkce: pkce ?? existingConfig.pkce,
      mapping: existingConfig.mapping,
    };

    let normalized;
    try {
      normalized = await normalizeOidcProviderConfig(effectiveIssuer, mergedConfig);
    } catch (error) {
      if (error instanceof OidcConfigError) {
        return new Response(
          JSON.stringify({ error: error.message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      throw error;
    }

    const storedOidcConfig = {
      ...normalized.oidcConfig,
      mapping: normalized.mapping,
    };

    const [updatedProvider] = await db
      .update(ssoProviders)
      .set({
        issuer: effectiveIssuer,
        domain: domain || existingProvider.domain,
        oidcConfig: JSON.stringify(storedOidcConfig),
        organizationId: organizationId !== undefined ? organizationId : existingProvider.organizationId,
        updatedAt: new Date(),
      })
      .where(and(eq(ssoProviders.id, providerId), eq(ssoProviders.userId, user.id)))
      .returning();

    const formattedProvider = formatProviderForClient(updatedProvider);

    return new Response(JSON.stringify(formattedProvider), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO providers API");
  }
}

// DELETE /api/sso/providers - Delete a provider by ID
export async function DELETE(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const url = new URL(context.request.url);
    const providerId = url.searchParams.get("id");

    if (!providerId) {
      return new Response(
        JSON.stringify({ error: "Provider ID is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const deleted = await db
      .delete(ssoProviders)
      .where(and(eq(ssoProviders.id, providerId), eq(ssoProviders.userId, user.id)))
      .returning();

    if (deleted.length === 0) {
      return new Response(JSON.stringify({ error: "Provider not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO providers API");
  }
}
