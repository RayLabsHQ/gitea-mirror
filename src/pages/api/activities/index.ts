import type { APIRoute } from "astro";
import { db, mirrorJobs } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import type { MirrorJob } from "@/lib/db/schema";
import { repoStatusEnum } from "@/types/Repository";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // Fetch mirror jobs associated with the user
    const jobs = await db
      .select()
      .from(mirrorJobs)
      .where(eq(mirrorJobs.userId, userId))
      .orderBy(sql`${mirrorJobs.timestamp} DESC`);

    const activities: MirrorJob[] = jobs.map((job) => ({
      id: job.id,
      userId: job.userId,
      repositoryId: job.repositoryId ?? undefined,
      repositoryName: job.repositoryName ?? undefined,
      organizationId: job.organizationId ?? undefined,
      organizationName: job.organizationName ?? undefined,
      status: repoStatusEnum.parse(job.status),
      details: job.details ?? undefined,
      message: job.message,
      timestamp: job.timestamp,
      jobType: job.jobType,
      batchId: job.batchId ?? undefined,
      totalItems: job.totalItems ?? undefined,
      completedItems: job.completedItems,
      itemIds: job.itemIds ?? undefined,
      completedItemIds: job.completedItemIds,
      inProgress: job.inProgress,
      startedAt: job.startedAt ?? undefined,
      completedAt: job.completedAt ?? undefined,
      lastCheckpoint: job.lastCheckpoint ?? undefined,
    }));

    return new Response(
      JSON.stringify({
        success: true,
        message: "Mirror job activities retrieved successfully.",
        activities,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "activities fetch", 500);
  }
};
