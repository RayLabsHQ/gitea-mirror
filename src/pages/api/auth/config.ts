import type { APIRoute } from "astro";
import { AuthConfig } from "@/lib/config";

export const GET: APIRoute = async () => {
  try {
    const config = {
      primaryMethod: AuthConfig.getPrimaryMethod(),
      methods: {
        local: AuthConfig.isMethodEnabled("local"),
        forward: AuthConfig.isMethodEnabled("forward"),
        oidc: AuthConfig.isMethodEnabled("oidc"),
      },
      allowLocalFallback: AuthConfig.isLocalFallbackAllowed(),
      oidcConfig: AuthConfig.isMethodEnabled("oidc") ? {
        redirectUri: AuthConfig.getOIDCRedirectURI(),
      } : null,
    };

    return new Response(JSON.stringify(config), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Auth Config Error:", error);
    return new Response(JSON.stringify({ 
      error: "Failed to get authentication configuration" 
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
