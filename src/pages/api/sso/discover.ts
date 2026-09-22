import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { safeFetch, OutboundUrlError } from "@/lib/utils/outbound-url";

// POST /api/sso/discover - Discover OIDC configuration from issuer URL
export async function POST(context: APIContext) {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const { issuer } = await context.request.json();

    if (!issuer || typeof issuer !== 'string' || issuer.trim() === '') {
      return new Response(JSON.stringify({ error: "Issuer URL is required and must be a valid string" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate issuer URL format while keeping trailing slash if provided
    const trimmedIssuer = issuer.trim();
    let parsedIssuer: URL;
    try {
      parsedIssuer = new URL(trimmedIssuer);
    } catch (e) {
      return new Response(
        JSON.stringify({ 
          error: "Invalid issuer URL format",
          details: `The provided URL "${issuer}" is not a valid URL. For Authentik, use format: https://your-authentik-domain/application/o/<app-slug>/`
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const issuerForDiscovery = trimmedIssuer.replace(/\/$/, "");
    const discoveryUrl = `${issuerForDiscovery}/.well-known/openid-configuration`;

    try {
      // Fetch OIDC discovery document with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      let response: Response;
      try {
        response = await safeFetch(discoveryUrl, {
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
          }
        });
      } catch (fetchError) {
        if (fetchError instanceof OutboundUrlError) {
          throw fetchError;
        }
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          throw new Error(`Request timeout: The OIDC provider at ${trimmedIssuer} did not respond within 10 seconds`);
        }
        throw new Error(`Network error: Could not connect to ${trimmedIssuer}. Please verify the URL is correct and accessible.`);
      } finally {
        clearTimeout(timeoutId);
      }
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`OIDC discovery document not found at ${discoveryUrl}. For Authentik, ensure you're using the correct application slug in the URL.`);
        } else if (response.status >= 500) {
          throw new Error(`OIDC provider error (${response.status}): The server at ${trimmedIssuer} returned an error.`);
        } else {
          throw new Error(`Failed to fetch discovery document (${response.status}): ${response.statusText}`);
        }
      }

      let config: any;
      try {
        config = await response.json();
      } catch (parseError) {
        throw new Error(`Invalid response: The discovery document from ${trimmedIssuer} is not valid JSON.`);
      }

      // Extract the essential endpoints
      const discoveredConfig = {
        issuer: config.issuer || trimmedIssuer,
        authorizationEndpoint: config.authorization_endpoint,
        tokenEndpoint: config.token_endpoint,
        userInfoEndpoint: config.userinfo_endpoint,
        jwksEndpoint: config.jwks_uri,
        // Additional useful fields
        scopes: config.scopes_supported || ["openid", "profile", "email"],
        responseTypes: config.response_types_supported || ["code"],
        grantTypes: config.grant_types_supported || ["authorization_code"],
        // Suggested domain from issuer
        suggestedDomain: parsedIssuer.hostname.replace("www.", ""),
      };

      return new Response(JSON.stringify(discoveredConfig), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("OIDC discovery error:", error);
      return new Response(
        JSON.stringify({ 
          error: "Failed to discover OIDC configuration",
          details: error instanceof Error ? error.message : "Unknown error"
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  } catch (error) {
    return createSecureErrorResponse(error, "SSO discover API");
  }
}
