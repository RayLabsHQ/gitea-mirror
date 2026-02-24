import type { APIRoute } from "astro";
import { db, repositories, configs } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import {
  repositoryVisibilityEnum,
  repoStatusEnum,
  type RepositoryApiResponse,
} from "@/types/Repository";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // Fetch the user's active configuration
    const [config] = await db
      .select()
      .from(configs)
      .where(and(eq(configs.userId, userId), eq(configs.isActive, true)));

    if (!config) {
      return jsonResponse({
        data: {
          success: false,
          error: "No active configuration found for this user",
        },
        status: 404,
      });
    }

    const githubConfig = config.githubConfig as {
      mirrorStarred: boolean;
      skipForks: boolean;
      privateRepositories: boolean;
    };

    // Build query conditions based on config
    const conditions = [eq(repositories.userId, userId)];

    // Note: We show ALL repositories in the list
    // The mirrorStarred and privateRepositories flags only control what gets mirrored,
    // not what's displayed in the repository list
    // Only skipForks is used for filtering the display since forked repos are often noise

    const rawRepositories = await db
      .select()
      .from(repositories)
      .where(and(...conditions))
      .orderBy(sql`name COLLATE NOCASE`);

    const response: RepositoryApiResponse = {
      success: true,
      message: "Repositories fetched successfully",
      repositories: rawRepositories.map((repo) => ({
        ...repo,
        organization: repo.organization ?? undefined,
        lastMirrored: repo.lastMirrored ?? undefined,
        errorMessage: repo.errorMessage ?? undefined,
        forkedFrom: repo.forkedFrom ?? undefined,
        status: repoStatusEnum.parse(repo.status),
        visibility: repositoryVisibilityEnum.parse(repo.visibility),
      })),
    };

    return jsonResponse({
      data: response,
      status: 200,
    });
  } catch (error) {
    return createSecureErrorResponse(error, "repositories fetch", 500);
  }
};
