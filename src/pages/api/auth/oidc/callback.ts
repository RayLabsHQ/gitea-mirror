import type { APIRoute } from "astro";
import { AuthConfig } from "@/lib/config";
import { completeOIDCAuth } from "@/lib/auth/oidc";
import { createAuthHeaders } from "@/lib/auth/middleware";

export const GET: APIRoute = async ({ url, request }) => {
  try {
    // Check if OIDC is enabled
    if (!AuthConfig.isMethodEnabled("oidc")) {
      return new Response("OIDC authentication is not enabled", {
        status: 400,
      });
    }

    // Get query parameters
    const searchParams = url.searchParams;
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    // Handle OIDC errors
    if (error) {
      console.error("OIDC Error:", error, errorDescription);
      return new Response(`OIDC Authentication Error: ${error} - ${errorDescription || "Unknown error"}`, {
        status: 400,
      });
    }

    // Validate required parameters
    if (!code) {
      return new Response("Missing authorization code", {
        status: 400,
      });
    }

    // Validate state parameter (CSRF protection)
    const cookieHeader = request.headers.get("Cookie");
    let storedState: string | undefined;
    
    if (cookieHeader) {
      const cookies = cookieHeader.split(";").reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split("=");
        acc[key] = value;
        return acc;
      }, {} as Record<string, string>);
      
      storedState = cookies.oidc_state;
    }

    if (!storedState || storedState !== state) {
      console.error("OIDC State mismatch:", { stored: storedState, received: state });
      return new Response("Invalid state parameter - possible CSRF attack", {
        status: 400,
      });
    }

    // Complete OIDC authentication
    const authResult = await completeOIDCAuth(code);
    
    if (!authResult) {
      return new Response("OIDC authentication failed", {
        status: 401,
      });
    }

    // Create authentication headers
    const authHeaders = createAuthHeaders(authResult.token);
    
    // Clear OIDC state cookie
    const headers = new Headers(authHeaders);
    headers.append("Set-Cookie", "oidc_state=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    headers.set("Location", "/"); // Redirect to dashboard

    return new Response(null, {
      status: 302,
      headers,
    });

  } catch (error) {
    console.error("OIDC Callback Error:", error);
    
    // Redirect to login page with error
    const errorMessage = encodeURIComponent(
      error instanceof Error ? error.message : "OIDC authentication failed"
    );
    
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/login?error=${errorMessage}`,
      },
    });
  }
};
