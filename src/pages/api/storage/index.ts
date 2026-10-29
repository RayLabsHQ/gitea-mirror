import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db, repositories } from "@/lib/db";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { buildStorageOverview } from "@/lib/repository-storage";
import { getStorageRefreshProgress } from "@/lib/storage-refresh";

/**
 * Storage the user's mirrors take up on the destination (#479): totals, per
 * destination owner and per repository. Reads only what syncs and Refresh
 * sizes recorded, so it never contacts the destination or the source. While a
 * Refresh sizes run is going, `refresh` carries its progress.
 */
export const GET: APIRoute = async (context) => {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        fullName: repositories.fullName,
        mirroredLocation: repositories.mirroredLocation,
        status: repositories.status,
        destinationProvider: repositories.destinationProvider,
        destinationSize: repositories.destinationSize,
        releaseAssetsSize: repositories.releaseAssetsSize,
        releaseAssetsCount: repositories.releaseAssetsCount,
        storageCheckedAt: repositories.storageCheckedAt,
      })
      .from(repositories)
      .where(eq(repositories.userId, user!.id));

    return new Response(JSON.stringify({
        success: true,
        ...buildStorageOverview(rows),
        refresh: getStorageRefreshProgress(user!.id),
      }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "storage overview", 500);
  }
};
