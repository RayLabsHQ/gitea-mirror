import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { auth } from "@/lib/auth";
import { db, ssoProviders } from "@/lib/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { normalizeOidcProviderConfig, OidcConfigError } from "@/lib/sso/oidc-config";
import { withBase } from "@/lib/base-path";

// POST /api/auth/sso/register - Register a new SSO provider using Better Auth
export async function POST(context: APIContext) {
  try {
    const { user, response: authResponse } = await requireAuth(context);
    if (authResponse) return authResponse;

    const body = await context.request.json();
    
    // Extract configuration based on provider type
    const { providerId, issuer, domain, organizationId, providerType = "oidc" } = body;

    // Validate required fields
    if (!providerId || !issuer || !domain) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: providerId, issuer, and domain" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Validate issuer URL format while preserving trailing slash when provided
    let validatedIssuer = issuer;
    if (issuer && typeof issuer === 'string' && issuer.trim() !== '') {
      try {
        const trimmedIssuer = issuer.trim();
        new URL(trimmedIssuer);
        validatedIssuer = trimmedIssuer;
      } catch (e) {
        return new Response(
          JSON.stringify({ error: `Invalid issuer URL format: ${issuer}` }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    } else {
      return new Response(
        JSON.stringify({ error: "Issuer URL cannot be empty" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    let registrationBody: any = {
      providerId,
      issuer: validatedIssuer,
      domain,
      organizationId,
    };

    if (providerType === "saml") {
      // SAML provider configuration
      const { 
        entryPoint, 
        cert, 
        callbackUrl,
        audience,
        wantAssertionsSigned = true,
        signatureAlgorithm = "sha256",
        digestAlgorithm = "sha256",
        identifierFormat = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        idpMetadata,
        spMetadata,
        mapping = {
          id: "nameID",
          email: "email",
          name: "displayName",
          firstName: "givenName",
          lastName: "surname",
        }
      } = body;

      registrationBody.samlConfig = {
        entryPoint,
        cert,
        callbackUrl:
          callbackUrl ||
          `${context.url.origin}${withBase(`/api/auth/sso/saml2/callback/${providerId}`)}`,
        audience: audience || context.url.origin,
        wantAssertionsSigned,
        signatureAlgorithm,
        digestAlgorithm,
        identifierFormat,
        idpMetadata,
        spMetadata,
      };
      registrationBody.mapping = mapping;
    } else {
      // OIDC provider configuration
      const {
        clientId,
        clientSecret,
        authorizationEndpoint,
        tokenEndpoint,
        jwksEndpoint,
        discoveryEndpoint,
        userInfoEndpoint,
        scopes,
        pkce = true,
        mapping,
      } = body;

      try {
        const normalized = await normalizeOidcProviderConfig(validatedIssuer, {
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

        registrationBody.oidcConfig = normalized.oidcConfig;
        registrationBody.mapping = normalized.mapping;
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
    }

    // Get the user's auth headers to make the request
    const headers = new Headers();
    const cookieHeader = context.request.headers.get("cookie");
    if (cookieHeader) {
      headers.set("cookie", cookieHeader);
    }

    // Register the SSO provider using Better Auth's API
    const response = await auth.api.registerSSOProvider({
      body: registrationBody,
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      return new Response(
        JSON.stringify({ error: `Failed to register SSO provider: ${error}` }),
        {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const result = await response.json();

    // Mirror provider entry into local SSO table for UI listing
    try {
      const existing = await db
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.providerId, registrationBody.providerId))
        .limit(1);

      const values: any = {
        issuer: registrationBody.issuer,
        domain: registrationBody.domain,
        organizationId: registrationBody.organizationId,
        updatedAt: new Date(),
      };

      if (registrationBody.oidcConfig) {
        values.oidcConfig = JSON.stringify({
          ...registrationBody.oidcConfig,
          mapping: registrationBody.mapping,
        });
      }

      if (existing.length > 0) {
        await db
          .update(ssoProviders)
          .set(values)
          .where(eq(ssoProviders.id, existing[0].id));
      } else {
        await db.insert(ssoProviders).values({
          id: nanoid(),
          issuer: registrationBody.issuer,
          domain: registrationBody.domain,
          oidcConfig: JSON.stringify({
            ...registrationBody.oidcConfig,
            mapping: registrationBody.mapping,
          }),
          userId: user.id,
          providerId: registrationBody.providerId,
          organizationId: registrationBody.organizationId,
        });
      }
    } catch (mirroringError) {
      console.warn("Failed to mirror SSO provider to local DB:", mirroringError);
    }

    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "SSO registration");
  }
}

// GET /api/auth/sso/register - Get all registered SSO providers
export async function GET(context: APIContext) {
  try {
    const { user, response: authResponse } = await requireAuth(context);
    if (authResponse) return authResponse;

    // For now, we'll need to query the database directly since Better Auth
    // doesn't provide a built-in API to list SSO providers
    // This will be implemented once we update the database schema
    
    // Return empty array for now - frontend expects array not object
    return new Response(
      JSON.stringify([]),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "SSO provider listing");
  }
}
