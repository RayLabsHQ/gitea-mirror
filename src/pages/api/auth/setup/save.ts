import type { APIRoute } from "astro";
import { z } from "zod";
import { saveAuthConfig } from "@/lib/db/queries/auth-config.js";
import { hasUsers } from "@/lib/db/queries/users.js";

// Validation schema for auth configuration
const authSetupSchema = z.object({
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
    // Only allow setup if no users exist (security measure)
    const userCount = await hasUsers();
    if (userCount) {
      return new Response(
        JSON.stringify({ error: "Setup can only be performed on fresh installations" }),
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
    const validationResult = authSetupSchema.safeParse(body);
    
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
    console.error("Error saving auth configuration:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save auth configuration" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
};