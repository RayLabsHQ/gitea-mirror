import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { db, ssoProviders } from "@/lib/db";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";

// GET /api/sso/providers - List all SSO providers
export async function GET(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const providers = await db.select().from(ssoProviders);

    // Parse JSON fields before sending
    const formattedProviders = providers.map(provider => ({
      ...provider,
      oidcConfig: provider.oidcConfig ? JSON.parse(provider.oidcConfig) : undefined,
      samlConfig: (provider as any).samlConfig ? JSON.parse((provider as any).samlConfig) : undefined,
    }));

    return new Response(JSON.stringify(formattedProviders), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO providers API");
  }
}

// POST /api/sso/providers - DEPRECATED legacy create (use Better Auth registration)
// This route remains for backward-compatibility only. Preferred flow:
// - Client/UI calls authClient.sso.register(...) to register with Better Auth
// - Server mirrors provider into local DB for listing
// Creation via this route is discouraged and may be removed in a future version.
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

    // Clean issuer URL (remove trailing slash); validate URL format
    let cleanIssuer = issuer;
    try {
      const issuerUrl = new URL(issuer.toString().trim());
      cleanIssuer = issuerUrl.toString().replace(/\/$/, "");
    } catch {
      return new Response(
        JSON.stringify({ error: `Invalid issuer URL format: ${issuer}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate OIDC endpoints: require discoveryEndpoint or at least authorization+token
    const hasDiscovery = typeof discoveryEndpoint === 'string' && discoveryEndpoint.trim() !== '';
    const hasCoreEndpoints = typeof authorizationEndpoint === 'string' && authorizationEndpoint.trim() !== ''
      && typeof tokenEndpoint === 'string' && tokenEndpoint.trim() !== '';
    if (!hasDiscovery && !hasCoreEndpoints) {
      return new Response(
        JSON.stringify({
          error: "Invalid OIDC configuration",
          details: "Provide discoveryEndpoint, or both authorizationEndpoint and tokenEndpoint."
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
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

    // Helper to validate and normalize URL strings (optional fields allowed)
    const validateUrl = (value?: string) => {
      if (!value || typeof value !== 'string' || value.trim() === '') return undefined;
      try {
        return new URL(value.trim()).toString();
      } catch {
        return undefined;
      }
    };

    // Create OIDC config object (store as-is for UI and for Better Auth registration)
    const oidcConfig = {
      clientId,
      clientSecret,
      authorizationEndpoint: validateUrl(authorizationEndpoint),
      tokenEndpoint: validateUrl(tokenEndpoint),
      jwksEndpoint: validateUrl(jwksEndpoint),
      userInfoEndpoint: validateUrl(userInfoEndpoint),
      discoveryEndpoint: validateUrl(discoveryEndpoint),
      scopes: scopes || ["openid", "email", "profile"],
      pkce: pkce !== false,
      mapping: mapping || {
        id: "sub",
        email: "email",
        emailVerified: "email_verified",
        name: "name",
        image: "picture",
      },
    };

    // First, register with Better Auth so the SSO plugin has the provider
    try {
      const headers = new Headers();
      const cookieHeader = context.request.headers.get("cookie");
      if (cookieHeader) headers.set("cookie", cookieHeader);

      const res = await auth.api.registerSSOProvider({
        body: {
          providerId,
          issuer: cleanIssuer,
          domain,
          organizationId,
          oidcConfig: {
            clientId: oidcConfig.clientId,
            clientSecret: oidcConfig.clientSecret,
            authorizationEndpoint: oidcConfig.authorizationEndpoint,
            tokenEndpoint: oidcConfig.tokenEndpoint,
            jwksEndpoint: oidcConfig.jwksEndpoint,
            discoveryEndpoint: oidcConfig.discoveryEndpoint,
            userInfoEndpoint: oidcConfig.userInfoEndpoint,
            scopes: oidcConfig.scopes,
            pkce: oidcConfig.pkce,
          },
          mapping: oidcConfig.mapping,
        },
        headers,
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(
          JSON.stringify({ error: `Failed to register SSO provider: ${errText}` }),
          { status: res.status || 500, headers: { "Content-Type": "application/json" } }
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: `Better Auth registration failed: ${message}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Insert new provider
    const [newProvider] = await db
      .insert(ssoProviders)
      .values({
        id: nanoid(),
        issuer: cleanIssuer,
        domain,
        oidcConfig: JSON.stringify(oidcConfig),
        userId: user.id,
        providerId,
        organizationId,
      })
      .returning();

    // Parse JSON fields before sending
    const formattedProvider = {
      ...newProvider,
      oidcConfig: newProvider.oidcConfig ? JSON.parse(newProvider.oidcConfig) : undefined,
      samlConfig: (newProvider as any).samlConfig ? JSON.parse((newProvider as any).samlConfig) : undefined,
    };

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
      scopes,
      organizationId,
    } = body;

    // Get existing provider
    const [existingProvider] = await db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.id, providerId))
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

    // Create updated OIDC config
    const updatedOidcConfig = {
      ...existingConfig,
      clientId: clientId || existingConfig.clientId,
      clientSecret: clientSecret || existingConfig.clientSecret,
      authorizationEndpoint: authorizationEndpoint || existingConfig.authorizationEndpoint,
      tokenEndpoint: tokenEndpoint || existingConfig.tokenEndpoint,
      jwksEndpoint: jwksEndpoint || existingConfig.jwksEndpoint,
      userInfoEndpoint: userInfoEndpoint || existingConfig.userInfoEndpoint,
      scopes: scopes || existingConfig.scopes || ["openid", "email", "profile"],
    };

    // Update provider
    const [updatedProvider] = await db
      .update(ssoProviders)
      .set({
        issuer: issuer || existingProvider.issuer,
        domain: domain || existingProvider.domain,
        oidcConfig: JSON.stringify(updatedOidcConfig),
        organizationId: organizationId !== undefined ? organizationId : existingProvider.organizationId,
        updatedAt: new Date(),
      })
      .where(eq(ssoProviders.id, providerId))
      .returning();

    // Parse JSON fields before sending
    const formattedProvider = {
      ...updatedProvider,
      oidcConfig: JSON.parse(updatedProvider.oidcConfig),
      samlConfig: (updatedProvider as any).samlConfig ? JSON.parse((updatedProvider as any).samlConfig) : undefined,
    };

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
      .where(eq(ssoProviders.id, providerId))
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
