import type { APIRoute } from "astro";
import type { MirrorRepoRequest } from "@/types/mirror";
import { db, configs, repositories } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { repositoryVisibilityEnum, repoStatusEnum } from "@/types/Repository";
import { syncGiteaRepo } from "@/lib/gitea";
import type { SyncRepoResponse } from "@/types/sync";
import { processWithResilience } from "@/lib/utils/concurrency";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: MirrorRepoRequest = await request.json();
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

    // Fetch config
    const configResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    const config = configResult[0];

    if (!config || !config.githubConfig.token) {
      return new Response(
        JSON.stringify({ error: "Config missing for the user or token." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch repos
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
        JSON.stringify({ error: "No repositories found for the given IDs." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Start async mirroring in background with parallel processing and resilience
    setTimeout(async () => {
      // Define the concurrency limit - adjust based on API rate limits
      const CONCURRENCY_LIMIT = 5;

      // Process repositories in parallel with resilience to container restarts
      await processWithResilience(
        repos,
        async (repo) => {
          // Prepare repository data
          const repoData = {
            ...repo,
            status: repoStatusEnum.parse(repo.status),
            organization: repo.organization ?? undefined,
            lastMirrored: repo.lastMirrored ?? undefined,
            errorMessage: repo.errorMessage ?? undefined,
            forkedFrom: repo.forkedFrom ?? undefined,
            visibility: repositoryVisibilityEnum.parse(repo.visibility),
            mirroredLocation: repo.mirroredLocation || "",
          };

          // Log the start of syncing
          console.log(`Starting sync for repository: ${repo.name}`);

          // Sync the repository
          await syncGiteaRepo({
            config,
            repository: repoData,
          });

          return repo;
        },
        {
          userId: config.userId || "",
          jobType: "sync",
          getItemId: (repo) => repo.id,
          getItemName: (repo) => repo.name,
          concurrencyLimit: CONCURRENCY_LIMIT,
          maxRetries: 2,
          retryDelay: 2000,
          checkpointInterval: 1, // Checkpoint after each repository
          onProgress: (completed, total, result) => {
            const percentComplete = Math.round((completed / total) * 100);
            console.log(`Syncing progress: ${percentComplete}% (${completed}/${total})`);

            if (result) {
              console.log(`Successfully synced repository: ${result.name}`);
            }
          },
          onRetry: (repo, error, attempt) => {
            console.log(`Retrying sync for repository ${repo.name} (attempt ${attempt}): ${error.message}`);
          }
        }
      );

      console.log("All repository syncing tasks completed");
    }, 0);

    const responsePayload: SyncRepoResponse = {
      success: true,
      message: "Sync job started.",
      repositories: repos.map((repo) => ({
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

    // Return the updated repo list to the user
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "repository sync", 500);
  }
};
