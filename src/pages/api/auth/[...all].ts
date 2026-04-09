import { auth } from "@/lib/auth";
import type { APIRoute } from "astro";
import { stripBasePath, withBase } from "@/lib/base-path";

export const ALL: APIRoute = async (ctx) => {
  // If you want to use rate limiting, make sure to set the 'x-forwarded-for' header
  // to the request headers from the context
  if (ctx.clientAddress) {
    ctx.request.headers.set("x-forwarded-for", ctx.clientAddress);
  }
  
  try {
    const requestUrl = new URL(ctx.request.url);
    requestUrl.pathname = withBase(stripBasePath(requestUrl.pathname));
    const authRequest = new Request(requestUrl, ctx.request);

    return await auth.handler(authRequest);
  } catch (error) {
    console.error("Auth handler error:", error);
    
    // Check if this is an SSO callback error
    const url = new URL(ctx.request.url);
    if (url.pathname.includes('/sso/callback')) {
      // Redirect to error page for SSO errors
      return Response.redirect(
        `${ctx.url.origin}${withBase('/auth-error')}?error=sso_callback_failed&error_description=${encodeURIComponent(
          error instanceof Error ? error.message : "SSO authentication failed"
        )}`,
        302
      );
    }
    
    // Return a proper error response for other errors
    return new Response(JSON.stringify({ 
      error: "Internal server error", 
      message: error instanceof Error ? error.message : "Unknown error" 
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
