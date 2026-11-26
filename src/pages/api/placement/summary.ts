import type { APIRoute } from "astro";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { loadPlacementConfig, placementSummary } from "@/lib/mirror-placement-service";

/**
 * How many mirrors are not under the owner the current settings name
 * (#550). Reads the database only, so the Organization Structure card can
 * ask after every change.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const loaded = await loadPlacementConfig(authResult.userId);
    if ("error" in loaded) {
      return jsonResponse({ data: { success: true, supported: false, outOfPlace: 0, inPlace: 0, reason: loaded.error } });
    }
    const summary = await placementSummary(authResult.userId, loaded.config);
    return jsonResponse({ data: { success: true, ...summary } });
  } catch (error) {
    return createSecureErrorResponse(error, "Mirror placement summary", 500);
  }
};
