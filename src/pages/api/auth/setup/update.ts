import type { APIRoute } from "astro";
import { z } from "zod";
import { saveAuthConfig } from "@/lib/db/queries/auth-config.js";
import { authenticate } from "@/lib/auth/middleware.js";
import { getUserById } from "@/lib/db/queries/users.js";
import { clearAuthConfigCache } from "@/lib/config/db-config.js";

// Validation schema for auth configuration update
const authUpdateSchema = z.object({
  method: z.enum(["local", "forward", "oidc"]),
  allowLocalFallback: z.boolean().optional().default(false),
  forwardAuth: z.object({
    userHeader: z.string().min(1),
    emailHeader: z.string().min(1),
    nameHeader: z.string().optional(),
    groupsHeader: z.string().optional(),
    trustedProxies: z.array(z.string()).min(1),
    autoCreateUsers: z.boolean().default(true),
  }).optional(),
  oidc: z.object({
    issuerUrl: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    redirectUri: z.string().url().optional(),
    scopes: z.array(z.string()).default(["openid", "profile", "email"]),
    autoCreateUsers: z.boolean().default(true),
    usernameClaim: z.string().default("preferred_username"),
    emailClaim: z.string().default("email"),
    nameClaim: z.string().default("name"),
  }).optional(),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    // Check if user is authenticated
    const auth = await authenticate(request);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    
    const user = auth.user;
    
    // Check if user is an admin (first user)
    const firstUser = await getUserById("1");
    if (!firstUser || user.id !== firstUser.id) {
      return new Response(
        JSON.stringify({ error: "Admin access required" }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    
    // Parse and validate request body
    const body = await request.json();
    const validationResult = authUpdateSchema.safeParse(body);
    
    if (!validationResult.success) {
      return new Response(
        JSON.stringify({ 
          error: "Invalid configuration", 
          details: validationResult.error.issues 
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    
    const config = validationResult.data;
    
    // Validate method-specific configuration
    if (config.method === "forward" && !config.forwardAuth) {
      return new Response(
        JSON.stringify({ error: "Forward auth configuration is required for forward method" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    
    if (config.method === "oidc" && !config.oidc) {
      return new Response(
        JSON.stringify({ error: "OIDC configuration is required for OIDC method" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    
    // Save configuration to database
    const savedConfig = await saveAuthConfig({
      method: config.method,
      allowLocalFallback: config.allowLocalFallback,
      forwardAuth: config.method === "forward" ? config.forwardAuth : undefined,
      oidc: config.method === "oidc" ? config.oidc : undefined,
    });
    
    // Clear the config cache so new settings take effect immediately
    clearAuthConfigCache();
    
    // Return success (without sensitive data)
    return new Response(
      JSON.stringify({
        success: true,
        method: savedConfig.method,
        allowLocalFallback: savedConfig.allowLocalFallback,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error updating auth configuration:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update auth configuration" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
};