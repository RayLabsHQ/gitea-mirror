import type { APIRoute } from "astro";
import { hasUsers } from "@/lib/db/queries/users.js";
import { hasAuthConfig } from "@/lib/db/queries/auth-config.js";

export const GET: APIRoute = async () => {
  try {
    // Check if setup is needed
    const userCount = await hasUsers();
    const authConfigExists = await hasAuthConfig();
    
    // Setup is needed if:
    // 1. No users exist (fresh installation)
    // 2. No auth configuration exists (need to configure auth)
    const needsSetup = !userCount || !authConfigExists;
    
    return new Response(
      JSON.stringify({
        needsSetup,
        hasUsers: userCount,
        hasAuthConfig: authConfigExists,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error checking setup status:", error);
    return new Response(
      JSON.stringify({ error: "Failed to check setup status" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
};