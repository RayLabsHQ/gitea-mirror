import type { APIRoute } from "astro";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, configs, repositories } from "@/lib/db";
import { repositoryVisibilityEnum, repoStatusEnum } from "@/types/Repository";
import type { ResetMetadataRequest, ResetMetadataResponse } from "@/types/reset-metadata";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: ResetMetadataRequest = await request.json();
    const { repositoryIds } = body;

    if (!repositoryIds || !Array.isArray(repositoryIds)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "repositoryIds are required.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (repositoryIds.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "No repository IDs provided.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Prefer active and most-recently-updated config to avoid picking a stale
    // inactive stub when multiple rows exist (see issue #271).
    const configResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    const config = configResult[0];

    if (!config || !config.githubConfig.token || !config.giteaConfig?.token) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing GitHub or Gitea configuration.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const repos = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, userId),
          inArray(repositories.id, repositoryIds)
        )
      );

    if (!repos.length) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "No repositories found for the given IDs.",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Clearing the whole state also drops the incremental sync
    // watermarks (#449), so the next issues and pull request passes are
    // full ones.
    await db
      .update(repositories)
      .set({
        metadata: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(repositories.userId, userId),
          inArray(repositories.id, repositoryIds)
        )
      );

    const updatedRepos = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, userId),
          inArray(repositories.id, repositoryIds)
        )
      );

    const responsePayload: ResetMetadataResponse = {
      success: true,
      message: "Metadata state reset. Trigger sync to re-run metadata import.",
      repositories: updatedRepos.map((repo) => ({
        ...repo,
        status: repoStatusEnum.parse(repo.status),
        organization: repo.organization ?? undefined,
        lastMirrored: repo.lastMirrored ?? undefined,
        errorMessage: repo.errorMessage ?? undefined,
        forkedFrom: repo.forkedFrom ?? undefined,
        visibility: repositoryVisibilityEnum.parse(repo.visibility),
        mirroredLocation: repo.mirroredLocation || "",
      })),
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "metadata reset", 500);
  }
};
