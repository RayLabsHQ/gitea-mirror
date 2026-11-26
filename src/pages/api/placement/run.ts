import type { APIRoute } from "astro";
import { z } from "zod";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { loadPlacementConfig } from "@/lib/mirror-placement-service";
import { PlacementRunBusyError, placementRunState, startPlacementRun } from "@/lib/mirror-placement-run";

const bodySchema = z.object({
  rename: z.boolean(),
  moves: z
    .array(z.object({ id: z.string().min(1), to: z.string().min(3).max(300) }))
    .min(1)
    .max(5000),
});

/**
 * Move the mirrors the preview showed (#550). Each one is checked again and
 * only moved when the check gives the same target. Answers 202 at once; the
 * run goes on in the background and GET reports its progress.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ data: { success: false, error: "Body must be JSON" }, status: 400 });
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({
        data: { success: false, error: "Send rename (boolean) and moves, a list of { id, to }" },
        status: 400,
      });
    }

    const loaded = await loadPlacementConfig(authResult.userId);
    if ("error" in loaded) {
      return jsonResponse({ data: { success: false, error: loaded.error }, status: loaded.status });
    }
    try {
      await startPlacementRun({
        userId: authResult.userId,
        config: loaded.config,
        rename: parsed.data.rename,
        moves: parsed.data.moves,
      });
    } catch (error) {
      if (error instanceof PlacementRunBusyError) {
        return jsonResponse({ data: { success: false, error: error.message }, status: 409 });
      }
      throw error;
    }
    return jsonResponse({ data: { success: true, run: placementRunState(authResult.userId) }, status: 202 });
  } catch (error) {
    return createSecureErrorResponse(error, "Move mirrors", 500);
  }
};

/** The current or last run's progress, or null. */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    return jsonResponse({ data: { success: true, run: placementRunState(authResult.userId) } });
  } catch (error) {
    return createSecureErrorResponse(error, "Move mirrors progress", 500);
  }
};
