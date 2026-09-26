import type { APIRoute } from "astro";
import { db, repositories, organizations, mirrorJobs, configs } from "@/lib/db";
import { eq, count, and, sql, or } from "drizzle-orm";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import type { DashboardApiResponse } from "@/types/dashboard";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const [
      userRepos,
      userOrgs,
      userLogs,
      [userConfig],
      [{ value: repoCount }],
      [{ value: orgCount }],
      [{ value: mirroredCount }],
    ] = await Promise.all([
      db
        .select()
        .from(repositories)
        .where(eq(repositories.userId, userId))
        .orderBy(sql`${repositories.updatedAt} DESC`)
        .limit(10),
      db
        .select()
        .from(organizations)
        .where(eq(organizations.userId, userId))
        .orderBy(sql`${organizations.updatedAt} DESC`)
        .limit(10), // not really needed in the frontend but just in case
      db
        .select()
        .from(mirrorJobs)
        .where(eq(mirrorJobs.userId, userId))
        // Timestamps are stored to the second; rowid keeps events written in
        // the same second newest first too (#454).
        .orderBy(sql`${mirrorJobs.timestamp} DESC, ${mirrorJobs}.rowid DESC`)
        .limit(10),
      db
        .select()
        .from(configs)
        .where(eq(configs.userId, userId))
        .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
        .limit(1),
      db
        .select({ value: count() })
        .from(repositories)
        .where(eq(repositories.userId, userId)),
      db
        .select({ value: count() })
        .from(organizations)
        .where(eq(organizations.userId, userId)),
      db
        .select({ value: count() })
        .from(repositories)
        .where(
          and(
            eq(repositories.userId, userId),
            or(
              eq(repositories.status, "mirrored"),
              eq(repositories.status, "synced")
            )
          )
        ),
    ]);

    const successResponse: DashboardApiResponse = {
      success: true,
      message: "Dashboard data loaded successfully",
      repoCount: repoCount ?? 0,
      orgCount: orgCount ?? 0,
      mirroredCount: mirroredCount ?? 0,
      repositories: userRepos,
      organizations: userOrgs,
      activities: userLogs,
      lastSync: userConfig?.scheduleConfig.lastRun ?? null,
    };

    return jsonResponse({ data: successResponse });
  } catch (error) {
    return createSecureErrorResponse(error, "dashboard data fetch", 500);
  }
};
