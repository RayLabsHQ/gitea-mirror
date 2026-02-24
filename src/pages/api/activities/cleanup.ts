import type { APIRoute } from "astro";
import { db, mirrorJobs, events } from "@/lib/db";
import { eq, count } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // Start a transaction to ensure all operations succeed or fail together
    const result = await db.transaction(async (tx) => {
      // Count activities before deletion
      const mirrorJobsCountResult = await tx
        .select({ count: count() })
        .from(mirrorJobs)
        .where(eq(mirrorJobs.userId, userId));

      const eventsCountResult = await tx
        .select({ count: count() })
        .from(events)
        .where(eq(events.userId, userId));

      const totalMirrorJobs = mirrorJobsCountResult[0]?.count || 0;
      const totalEvents = eventsCountResult[0]?.count || 0;

      console.log(`Found ${totalMirrorJobs} mirror jobs and ${totalEvents} events to delete for user ${userId}`);

      // First, mark all in-progress jobs as completed/failed to allow deletion
      await tx
        .update(mirrorJobs)
        .set({
          inProgress: false,
          completedAt: new Date(),
          status: "failed",
          message: "Job interrupted and cleaned up by user"
        })
        .where(eq(mirrorJobs.userId, userId));

      console.log(`Updated in-progress jobs to allow deletion`);

      // Delete all mirror jobs for the user (now that none are in progress)
      await tx
        .delete(mirrorJobs)
        .where(eq(mirrorJobs.userId, userId));

      // Delete all events for the user
      await tx
        .delete(events)
        .where(eq(events.userId, userId));

      return {
        mirrorJobsDeleted: totalMirrorJobs,
        eventsDeleted: totalEvents,
        totalMirrorJobs,
        totalEvents,
      };
    });

    console.log(`Cleaned up activities for user ${userId}:`, result);

    return new Response(
      JSON.stringify({
        success: true,
        message: "All activities cleaned up successfully.",
        result: {
          mirrorJobsDeleted: result.mirrorJobsDeleted,
          eventsDeleted: result.eventsDeleted,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "activities cleanup", 500);
  }
};
