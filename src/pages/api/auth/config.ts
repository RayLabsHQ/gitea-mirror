import type { APIContext } from "astro";
import { getAuthConfig } from "@/lib/db/queries/auth-config.js";
import { createSecureErrorResponse } from "@/lib/utils";
import { ENV } from "@/lib/config";

export async function GET({ request }: APIContext) {
  try {
    // This endpoint is public to allow checking auth configuration
    // before authentication (needed for login page)
    
    // First check database configuration
    const dbConfig = await getAuthConfig();
    
    // If database config exists, use it. Otherwise default to local auth
    const config = dbConfig || {
      method: "local" as const,
      allowLocalFallback: false,
      forwardAuth: undefined,
      oidc: undefined,
    };
    
    // Determine if the auth method is properly configured
    let isConfigured = false;
    
    if (config.method === "local") {
      isConfigured = true; // Local auth is always configured
    } else if (config.method === "forward" && config.forwardAuth) {
      isConfigured = config.forwardAuth.trustedProxies.length > 0;
    } else if (config.method === "oidc" && config.oidc) {
      isConfigured = !!(config.oidc.issuerUrl && config.oidc.clientId);
    }
    
    // Don't send sensitive data like client secrets
    const sanitizedConfig = {
      method: config.method,
      allowLocalFallback: config.allowLocalFallback,
      isConfigured,
      forwardAuth: config.forwardAuth ? {
        userHeader: config.forwardAuth.userHeader,
        emailHeader: config.forwardAuth.emailHeader,
        nameHeader: config.forwardAuth.nameHeader,
        groupsHeader: config.forwardAuth.groupsHeader,
        trustedProxies: config.forwardAuth.trustedProxies,
        autoCreateUsers: config.forwardAuth.autoCreateUsers,
      } : undefined,
      oidc: config.oidc ? {
        issuerUrl: config.oidc.issuerUrl,
        clientId: config.oidc.clientId,
        // Don't send clientSecret
        redirectUri: config.oidc.redirectUri,
        scopes: config.oidc.scopes,
        autoCreateUsers: config.oidc.autoCreateUsers,
        usernameClaim: config.oidc.usernameClaim,
        emailClaim: config.oidc.emailClaim,
        nameClaim: config.oidc.nameClaim,
      } : undefined,
    };
    
    return new Response(
      JSON.stringify({
        success: true,
        config: sanitizedConfig,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "auth config", 500);
  }
}