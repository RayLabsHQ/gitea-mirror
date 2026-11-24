import type { APIRoute } from "astro";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { runDatabaseCleanupNow } from "@/lib/cleanup-service";
import { createSecureErrorResponse } from "@/lib/utils";

/**
 * Run database maintenance for the current user now: the Run now button on
 * the Database Maintenance card (#547). Activity log entries and events older
 * than the saved retention period are removed, and the next scheduled run
 * moves to a full interval from now.
 */
export const POST: APIRoute = async (context) => {
  try {
    const authResult = await requireAuthenticatedUserId(context);
    if ("response" in authResult) return authResult.response;

    const result = await runDatabaseCleanupNow(authResult.userId);

    return new Response(
      JSON.stringify({
        success: true,
        eventsDeleted: result.eventsDeleted,
        mirrorJobsDeleted: result.mirrorJobsDeleted,
        lastRun: result.lastRun.toISOString(),
        nextRun: result.nextRun.toISOString(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[Cleanup API] Error during manual database maintenance:", error);
    return createSecureErrorResponse(error, "database maintenance", 500);
  }
};
