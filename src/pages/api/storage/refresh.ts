import type { APIRoute } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { startStorageRefresh } from "@/lib/storage-refresh";

/**
 * Refresh sizes: measure every mirror on the destination now. Starts a run in
 * the background, or reports the one already running, and answers with its
 * progress; GET /api/storage keeps reporting it until it ends. Only the
 * destination is read.
 */
export const POST: APIRoute = async (context) => {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const result = await startStorageRefresh(user!.id);
    if (!result.ok) {
      return new Response(JSON.stringify({ success: false, error: result.error }), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, refresh: result.progress }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "refresh storage sizes", 500);
  }
};
