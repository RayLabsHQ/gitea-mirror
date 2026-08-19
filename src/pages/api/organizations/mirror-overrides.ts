import type { APIRoute } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { loadOrganizationMirrorOverrides } from "@/lib/utils/mirror-overrides";

/**
 * Look up one organization's mirror overrides by name.
 *
 * The repositories payload carries an organization *name*, not an id, so the
 * repository overrides dialog needs a name-keyed lookup to show what "Inherit"
 * actually resolves to (global -> org). Reuses the same loader the mirror paths
 * use, which scopes the query to the calling user.
 *
 * GET /api/organizations/mirror-overrides?name=<orgName>
 */
export const GET: APIRoute = async (context) => {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const name = context.url.searchParams.get("name")?.trim();
    if (!name) {
      return new Response(
        JSON.stringify({ error: "Organization name is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Returns null for unknown orgs, which the caller treats the same as
    // "no overrides" — the hint then falls back to the global values.
    const mirrorOverrides = await loadOrganizationMirrorOverrides({
      organizationName: name,
      userId: user!.id,
    });

    return new Response(
      JSON.stringify({ success: true, name, mirrorOverrides }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return createSecureErrorResponse(
      error,
      "Load organization mirror overrides",
      500
    );
  }
};
