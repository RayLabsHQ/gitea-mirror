import type { APIRoute } from "astro";
import { auth } from "@/lib/auth";
import { ENV } from "@/lib/config";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  // Only available in development
  if (ENV.NODE_ENV === "production") {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const info = {
      baseURL: auth.options.baseURL,
      basePath: auth.options.basePath,
      emailPasswordEnabled: auth.options.emailAndPassword?.enabled,
    };

    return new Response(JSON.stringify({
      success: true,
      config: info,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Debug endpoint error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: "An unexpected error occurred",
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
