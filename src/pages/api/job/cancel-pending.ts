import type { APIRoute } from "astro";
import { db, repositories } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { repoStatusEnum } from "@/types/Repository";
import { createMirrorJob } from "@/lib/helpers";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

/**
 * POST /api/job/cancel-pending
 *
 * Sets this user's repositories that are waiting to be mirrored
 * (status: "imported" or "failed") to "ignored", preventing the scheduler
 * from picking them up.  Repos with status "mirroring" or "syncing" are
 * left alone because they have in-flight work that cannot be aborted here.
 *
 * Returns the count of affected repositories and logs one activity entry.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // Statuses that represent queued-but-not-started work.
    // "imported"  → repo was discovered, never mirrored
    // "failed"    → last mirror attempt failed; scheduler will retry
    const cancelableStatuses = ["imported", "failed"] as const;

    // Fetch repos to cancel so we can count them and log meaningful details.
    const toCancel = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, userId),
          inArray(repositories.status, cancelableStatuses),
        ),
      );

    const cancelCount = toCancel.length;

    if (cancelCount > 0) {
      const ids = toCancel.map((r) => r.id);

      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("ignored"),
          updatedAt: new Date(),
          errorMessage: "Cancelled by user — set to ignored via Stop Pending Mirrors.",
        })
        .where(
          and(
            eq(repositories.userId, userId),
            inArray(repositories.id, ids),
          ),
        );
    }

    // Log a single activity summarising the bulk action.
    await createMirrorJob({
      userId,
      message: `Stopped pending mirrors: ${cancelCount} repositor${cancelCount === 1 ? "y" : "ies"} set to Ignored`,
      details:
        cancelCount > 0
          ? `${cancelCount} repositor${cancelCount === 1 ? "y" : "ies"} with status "imported" or "failed" have been set to "ignored". ` +
            `They can be re-enabled from the Repositories page.`
          : `No repositories in a pending state were found for this user.`,
      status: cancelCount > 0 ? "ignored" : "skipped",
      skipDuplicateEvent: false,
      skipNotification: true,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message:
          cancelCount > 0
            ? `${cancelCount} repositor${cancelCount === 1 ? "y has" : "ies have"} been set to Ignored.`
            : "No repositories in a pending state were found.",
        cancelledCount: cancelCount,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    return createSecureErrorResponse(error, "cancel pending mirrors", 500);
  }
};
