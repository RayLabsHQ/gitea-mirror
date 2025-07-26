import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { db, ssoProviders } from "@/lib/db";

// GET /api/sso/providers/public - Get public SSO provider information for login page
export async function GET(context: APIContext) {
  try {
    // Get all providers but only return public information
    const providers = await db.select({
      id: ssoProviders.id,
      providerId: ssoProviders.providerId,
      domain: ssoProviders.domain,
    }).from(ssoProviders);

    return new Response(JSON.stringify(providers), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "Public SSO providers API");
  }
}