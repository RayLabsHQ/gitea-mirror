import type { APIRoute } from "astro";
import { createLogoutHeaders } from "@/lib/auth/middleware";

export const POST: APIRoute = async () => {
  // Clear the authentication cookie
  const headers = createLogoutHeaders();
  
  return new Response(
    JSON.stringify({ success: true, message: "Logged out successfully" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    }
  );
};

export const GET: APIRoute = async () => {
  // Also support GET for browser navigation
  const headers = createLogoutHeaders();
  
  // Redirect to login page
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      Location: "/login",
    },
  });
};
