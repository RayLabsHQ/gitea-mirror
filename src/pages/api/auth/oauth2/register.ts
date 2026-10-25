import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { auth } from "@/lib/auth";

// POST /api/auth/oauth2/register - Register a new OAuth2 application
export async function POST(context: APIContext) {
  try {
    // Delegate to Better Auth's RFC 7591 endpoint. MCP clients must register
    // before authorization, so this endpoint intentionally permits public
    // clients; consent and the provider's client metadata validation remain
    // in force. Use the request handler to preserve the session, IP, and
    // OAuth-provider request context.
    if (context.clientAddress) {
      context.request.headers.set("x-forwarded-for", context.clientAddress);
    }
    return await auth.handler(context.request);
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
