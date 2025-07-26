import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { auth } from "@/lib/auth";

// POST /api/auth/oauth2/register - Register a new OAuth2 application
export async function POST(context: APIContext) {
  try {
    const { response: authResponse } = await requireAuth(context);
    if (authResponse) return authResponse;

    const body = await context.request.json();
    
    // Extract and validate required fields
    const {
      client_name,
      redirect_uris,
      token_endpoint_auth_method = "client_secret_basic",
      grant_types = ["authorization_code"],
      response_types = ["code"],
      client_uri,
      logo_uri,
      scope = "openid profile email",
      contacts,
      tos_uri,
      policy_uri,
      jwks_uri,
      jwks,
      metadata,
      software_id,
      software_version,
      software_statement,
    } = body;

    // Validate required fields
    if (!client_name || !redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return new Response(
        JSON.stringify({ 
          error: "invalid_request",
          error_description: "client_name and redirect_uris are required" 
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    try {
      // Use Better Auth server API to register OAuth2 application
      const response = await auth.api.registerOAuthApplication({
        body: {
          client_name,
          redirect_uris,
          token_endpoint_auth_method,
          grant_types,
          response_types,
          client_uri,
          logo_uri,
          scope,
          contacts,
          tos_uri,
          policy_uri,
          jwks_uri,
          jwks,
          metadata,
          software_id,
          software_version,
          software_statement,
        },
      });

      // Check if response is an error
      if (!response || typeof response !== 'object') {
        return new Response(
          JSON.stringify({ 
            error: "registration_error",
            error_description: "Invalid response from server" 
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // The response follows OAuth2 RFC format with snake_case
      return new Response(JSON.stringify(response), {
        status: 201,
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Pragma": "no-cache"
        },
      });
    } catch (error: any) {
      // Handle Better Auth errors
      if (error.message?.includes('already exists')) {
        return new Response(
          JSON.stringify({ 
            error: "invalid_client_metadata",
            error_description: "Client with this configuration already exists" 
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      throw error;
    }
  } catch (error) {
    return createSecureErrorResponse(error, "OAuth2 registration");
  }
}

// GET /api/auth/oauth2/register - Get all registered OAuth2 applications
export async function GET(context: APIContext) {
  try {
    const { response: authResponse } = await requireAuth(context);
    if (authResponse) return authResponse;

    // TODO: Implement listing of OAuth2 applications
    // This would require querying the database directly
    
    return new Response(
      JSON.stringify({ 
        applications: [],
        message: "OAuth2 application listing not yet implemented" 
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "OAuth2 application listing");
  }
}