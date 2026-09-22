import type { APIRoute } from "astro";
import { db, ssoProviders } from "@/lib/db";
import { createSecureErrorResponse } from "@/lib/utils";
import { parseDefaultAuthMethod } from "@/lib/utils/auth-method";

// GET /api/auth/methods - which sign-in methods this instance offers, and
// which one the login page should open on. Public: the login page calls it
// before anyone is signed in, so it only exposes what a login form needs.
export const GET: APIRoute = async () => {
  try {
    // Same public projection as /api/sso/providers/public.
    const providers = await db
      .select({
        id: ssoProviders.id,
        providerId: ssoProviders.providerId,
        domain: ssoProviders.domain,
      })
      .from(ssoProviders);

    return new Response(
      JSON.stringify({
        // Email and password sign-in is always available.
        emailPassword: true,
        sso: {
          enabled: providers.length > 0,
          providers,
        },
        // Registered OAuth applications are not a login method for this
        // page and are not disclosed to anonymous callers.
        oidc: {
          enabled: false,
        },
        defaultMethod: parseDefaultAuthMethod(process.env.AUTH_DEFAULT_METHOD),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "Auth methods API");
  }
};
