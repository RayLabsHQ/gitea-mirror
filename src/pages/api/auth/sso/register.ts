import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { auth } from "@/lib/auth";
import { db, ssoProviders } from "@/lib/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

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

    // Validate issuer URL format
    let validatedIssuer = issuer;
    if (issuer && typeof issuer === 'string' && issuer.trim() !== '') {
      try {
        const issuerUrl = new URL(issuer.trim());
        validatedIssuer = issuerUrl.toString().replace(/\/$/, ''); // Remove trailing slash
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
        callbackUrl: callbackUrl || `${context.url.origin}/api/auth/sso/saml2/callback/${providerId}`,
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
        mapping = {
          id: "sub",
          email: "email",
          emailVerified: "email_verified",
          name: "name",
          image: "picture",
        }
      } = body;

      // Use provided scopes or default if not specified
      const finalScopes = scopes || ["openid", "email", "profile"];

      // Validate endpoint URLs if provided
      const validateUrl = (url: string | undefined, name: string): string | undefined => {
        if (!url) return undefined;
        if (typeof url !== 'string' || url.trim() === '') return undefined;
        try {
          const validatedUrl = new URL(url.trim());
          return validatedUrl.toString();
        } catch (e) {
          console.warn(`Invalid ${name} URL: ${url}, skipping`);
          return undefined;
        }
      };

      registrationBody.oidcConfig = {
        clientId: clientId || undefined,
        clientSecret: clientSecret || undefined,
        authorizationEndpoint: validateUrl(authorizationEndpoint, 'authorization endpoint'),
        tokenEndpoint: validateUrl(tokenEndpoint, 'token endpoint'),
        jwksEndpoint: validateUrl(jwksEndpoint, 'JWKS endpoint'),
        discoveryEndpoint: validateUrl(discoveryEndpoint, 'discovery endpoint'),
        userInfoEndpoint: validateUrl(userInfoEndpoint, 'userinfo endpoint'),
        scopes: finalScopes,
        pkce,
      };
      registrationBody.mapping = mapping;
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

    // Mirror provider into our local sso_providers table for UI listing
    try {
      const existing = await db
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.providerId, providerId))
        .limit(1);

      const values: any = {
        issuer: registrationBody.issuer,
        domain: registrationBody.domain,
        organizationId: registrationBody.organizationId,
        updatedAt: new Date(),
      };
      if (registrationBody.oidcConfig) {
        values.oidcConfig = JSON.stringify(registrationBody.oidcConfig);
      }
      if (registrationBody.samlConfig) {
        values.samlConfig = JSON.stringify(registrationBody.samlConfig);
      }

      if (existing.length > 0) {
        await db.update(ssoProviders).set(values).where(eq(ssoProviders.id, existing[0].id));
      } else {
        await db.insert(ssoProviders).values({
          id: nanoid(),
          issuer: registrationBody.issuer,
          domain: registrationBody.domain,
          oidcConfig: JSON.stringify(registrationBody.oidcConfig || {}),
          samlConfig: registrationBody.samlConfig ? JSON.stringify(registrationBody.samlConfig) : undefined,
          userId: user.id,
          providerId: registrationBody.providerId,
          organizationId: registrationBody.organizationId,
        });
      }
    } catch (e) {
      // Do not fail the main request if mirroring to local table fails
      console.warn("Failed to mirror SSO provider to local DB:", e);
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
