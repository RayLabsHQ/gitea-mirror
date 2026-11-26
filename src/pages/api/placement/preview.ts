import type { APIRoute } from "astro";
import { z } from "zod";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import {
  giteaPlacementDeps,
  loadPlacementConfig,
  previewPlacement,
  scanUserPlacement,
} from "@/lib/mirror-placement-service";

const bodySchema = z.object({ rename: z.boolean().optional().default(true) });

/**
 * Plan moving existing mirrors to where the current settings put them
 * (#550): which can move and where to, which are blocked and why, and which
 * are left out. Asks the destination, changes nothing.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const raw = await request.text();
    let body: unknown = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return jsonResponse({ data: { success: false, error: "Body must be JSON" }, status: 400 });
      }
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ data: { success: false, error: "rename must be a boolean" }, status: 400 });
    }

    const loaded = await loadPlacementConfig(authResult.userId);
    if ("error" in loaded) {
      return jsonResponse({ data: { success: false, error: loaded.error }, status: loaded.status });
    }
    const scan = await scanUserPlacement(authResult.userId, loaded.config);
    const preview = await previewPlacement({
      scan,
      config: loaded.config,
      rename: parsed.data.rename,
      deps: giteaPlacementDeps(loaded.config),
    });
    return jsonResponse({ data: { success: true, ...preview } });
  } catch (error) {
    return createSecureErrorResponse(error, "Mirror placement preview", 500);
  }
};
