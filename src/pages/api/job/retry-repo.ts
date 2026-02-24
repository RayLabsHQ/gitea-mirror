import type { APIRoute } from "astro";
import { db, configs, repositories } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { getGiteaRepoOwnerAsync, isRepoPresentInGitea } from "@/lib/gitea";
import {
  mirrorGithubRepoToGitea,
  mirrorGitHubOrgRepoToGiteaOrg,
  syncGiteaRepo,
} from "@/lib/gitea";
import { createGitHubClient } from "@/lib/github";
import { repoStatusEnum, repositoryVisibilityEnum } from "@/types/Repository";
import type { RetryRepoRequest, RetryRepoResponse } from "@/types/retry";
import { processWithRetry } from "@/lib/utils/concurrency";
import { createMirrorJob } from "@/lib/helpers";
import { createSecureErrorResponse } from "@/lib/utils";
import { getDecryptedGitHubToken } from "@/lib/utils/config-encryption";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: RetryRepoRequest = await request.json();
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

    // Fetch user config
    const configResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    const config = configResult[0];

    if (!config || !config.githubConfig.token || !config.giteaConfig?.token) {
      return new Response(
        JSON.stringify({ error: "Missing GitHub or Gitea configuration." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch repositories
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

    // Start background retry with parallel processing
    setTimeout(async () => {
      // Create a single Octokit instance to be reused if needed with rate limit tracking
      const decryptedToken = config.githubConfig.token
        ? getDecryptedGitHubToken(config)
        : null;
      const githubUsername = config.githubConfig?.owner || undefined;
      const octokit = decryptedToken
        ? createGitHubClient(decryptedToken, userId, githubUsername)
        : null;

      // Define the concurrency limit - adjust based on API rate limits
      const CONCURRENCY_LIMIT = 3;

      // Process repositories in parallel with retry capability
      await processWithRetry(
        repos,
        async (repo) => {
          // Prepare repository data
          const visibility = repositoryVisibilityEnum.parse(repo.visibility);
          const status = repoStatusEnum.parse(repo.status);
          const repoData = {
            ...repo,
            visibility,
            status,
            organization: repo.organization ?? undefined,
            lastMirrored: repo.lastMirrored ?? undefined,
            errorMessage: repo.errorMessage ?? undefined,
            forkedFrom: repo.forkedFrom ?? undefined,
            mirroredLocation: repo.mirroredLocation || "",
          };

          // Log the start of retry operation
          console.log(`Starting retry for repository: ${repo.name}`);

          // Create a mirror job entry to track progress
          await createMirrorJob({
            userId: config.userId || "",
            repositoryId: repo.id,
            repositoryName: repo.name,
            message: `Started retry operation for repository: ${repo.name}`,
            details: `Repository ${repo.name} is now in the retry queue.`,
            status: "imported",
          });

          // Determine if the repository exists in Gitea (with organization overrides)
          let owner = await getGiteaRepoOwnerAsync({
            config,
            repository: repoData,
          });

          const present = await isRepoPresentInGitea({
            config,
            owner,
            repoName: repo.name,
          });

          if (present) {
            // If the repository exists, sync it
            await syncGiteaRepo({ config, repository: repoData });
            console.log(`Synced existing repo: ${repo.name}`);
          } else {
            // If the repository doesn't exist, mirror it
            if (!config.githubConfig.token) {
              throw new Error("GitHub token is missing.");
            }

            if (!octokit) {
              throw new Error("Octokit client is not initialized.");
            }

            console.log(`Importing repo: ${repo.name} to owner: ${owner}`);

            // For single-org strategy, or when mirroring to an org,
            // use the org mirroring function to ensure proper organization handling
            const mirrorStrategy = config.githubConfig?.mirrorStrategy || 
              (config.giteaConfig?.preserveOrgStructure ? "preserve" : "flat-user");
            
            const shouldUseOrgMirror = 
              owner !== config.giteaConfig?.defaultOwner || // Different owner means org
              mirrorStrategy === "single-org"; // Single-org strategy always uses org

            if (shouldUseOrgMirror) {
              await mirrorGitHubOrgRepoToGiteaOrg({
                config,
                octokit,
                orgName: owner,
                repository: {
                  ...repoData,
                  status: repoStatusEnum.parse("imported"),
                },
              });
            } else {
              await mirrorGithubRepoToGitea({
                config,
                octokit,
                repository: {
                  ...repoData,
                  status: repoStatusEnum.parse("imported"),
                },
              });
            }
          }

          return repo;
        },
        {
          concurrencyLimit: CONCURRENCY_LIMIT,
          maxRetries: 2,
          retryDelay: 2000,
          onProgress: (completed, total, result) => {
            const percentComplete = Math.round((completed / total) * 100);
            console.log(`Retry progress: ${percentComplete}% (${completed}/${total})`);

            if (result) {
              console.log(`Successfully processed repository: ${result.name}`);
            }
          },
          onRetry: (repo, error, attempt) => {
            console.log(`Retrying repository ${repo.name} (attempt ${attempt}): ${error.message}`);
          }
        }
      );

      console.log("All repository retry tasks completed");
    }, 0);

    const responsePayload: RetryRepoResponse = {
      success: true,
      message: "Retry job (sync/mirror) started.",
      repositories: repos.map((repo) => ({
        ...repo,
        status: repoStatusEnum.parse(repo.status),
        organization: repo.organization ?? undefined,
        lastMirrored: repo.lastMirrored ?? undefined,
        errorMessage: repo.errorMessage ?? undefined,
        forkedFrom: repo.forkedFrom ?? undefined,
        visibility: repositoryVisibilityEnum.parse(repo.visibility),
      })),
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return createSecureErrorResponse(err, "repository retry", 500);
  }
};
