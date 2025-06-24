import type { APIRoute } from "astro";
import { AuthConfig } from "@/lib/config";
import { generateAuthorizationUrl } from "@/lib/auth/oidc";

export const GET: APIRoute = async ({ url }) => {
  try {
    // Check if OIDC is enabled
    if (!AuthConfig.isMethodEnabled("oidc")) {
      return new Response(JSON.stringify({ error: "OIDC authentication is not enabled" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate OIDC configuration
    const validation = AuthConfig.validateOIDCConfig();
    if (!validation.valid) {
      return new Response(JSON.stringify({ 
        error: "OIDC configuration is invalid", 
        details: validation.errors 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Generate state and nonce parameters for security
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    
    // Generate authorization URL
    const authUrl = await generateAuthorizationUrl(state, nonce);

    // Store state and nonce in cookies for validation
    const headers = new Headers();
    headers.append("Set-Cookie", `oidc_state=${state}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`); // 10 minutes
    headers.append("Set-Cookie", `oidc_nonce=${nonce}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`); // 10 minutes

    // Redirect to OIDC provider
    headers.set("Location", authUrl);
    
    return new Response(null, {
      status: 302,
      headers,
    });

  } catch (error) {
    console.error("OIDC Login Error:", error);
    return new Response(JSON.stringify({ 
      error: "Failed to initiate OIDC login",
      details: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
