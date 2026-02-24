import type { APIRoute } from "astro";
import type { MirrorRepoRequest, MirrorRepoResponse } from "@/types/mirror";
import { db, configs, repositories } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { repositoryVisibilityEnum, repoStatusEnum } from "@/types/Repository";
import {
  mirrorGithubRepoToGitea,
  mirrorGitHubOrgRepoToGiteaOrg,
  getGiteaRepoOwnerAsync,
} from "@/lib/gitea";
import { createGitHubClient } from "@/lib/github";
import { getDecryptedGitHubToken } from "@/lib/utils/config-encryption";
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
      if (!config.githubConfig.token) {
        throw new Error("GitHub token is missing.");
      }

      // Create a single Octokit instance to be reused with rate limit tracking
      const decryptedToken = getDecryptedGitHubToken(config);
      const githubUsername = config.githubConfig?.owner || undefined;
      const octokit = createGitHubClient(decryptedToken, userId, githubUsername);

      // Define the concurrency limit - adjust based on API rate limits
      const CONCURRENCY_LIMIT = 3;

      // Process repositories in parallel with resilience to container restarts
      await processWithResilience(
        repos,
        async (repo) => {
          // Prepare repository data
          const repoData = {
            ...repo,
            status: repoStatusEnum.parse("imported"),
            organization: repo.organization ?? undefined,
            lastMirrored: repo.lastMirrored ?? undefined,
            errorMessage: repo.errorMessage ?? undefined,
            forkedFrom: repo.forkedFrom ?? undefined,
            visibility: repositoryVisibilityEnum.parse(repo.visibility),
            mirroredLocation: repo.mirroredLocation || "",
          };

          // Log the start of mirroring
          console.log(`Starting mirror for repository: ${repo.name}`);

          // Determine where the repository should be mirrored (with organization overrides)
          const owner = await getGiteaRepoOwnerAsync({
            config,
            repository: repoData,
          });

          console.log(`Repository ${repo.name} will be mirrored to owner: ${owner}`);

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
              repository: repoData,
            });
          } else {
            await mirrorGithubRepoToGitea({
              octokit,
              repository: repoData,
              config,
            });
          }

          return repo;
        },
        {
          userId: config.userId || "",
          jobType: "mirror",
          getItemId: (repo) => repo.id,
          getItemName: (repo) => repo.name,
          concurrencyLimit: CONCURRENCY_LIMIT,
          maxRetries: 2,
          retryDelay: 2000,
          checkpointInterval: 5, // Checkpoint every 5 repositories to reduce event frequency
          onProgress: (completed, total, result) => {
            const percentComplete = Math.round((completed / total) * 100);
            console.log(
              `Mirroring progress: ${percentComplete}% (${completed}/${total})`
            );

            if (result) {
              console.log(`Successfully mirrored repository: ${result.name}`);
            }
          },
          onRetry: (repo, error, attempt) => {
            console.log(
              `Retrying repository ${repo.name} (attempt ${attempt}): ${error.message}`
            );
          },
        }
      );

      console.log("All repository mirroring tasks completed");
    }, 0);

    const responsePayload: MirrorRepoResponse = {
      success: true,
      message: "Mirror job started.",
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
    // Enhanced error logging for better debugging
    console.error("=== ERROR MIRRORING REPOSITORIES ===");
    console.error("Error type:", error?.constructor?.name);
    console.error(
      "Error message:",
      error instanceof Error ? error.message : String(error)
    );

    if (error instanceof Error) {
      console.error("Error stack:", error.stack);
    }

    // Log additional context
    console.error("Request details:");
    console.error("- URL:", request.url);
    console.error("- Method:", request.method);
    console.error("- Headers:", Object.fromEntries(request.headers.entries()));

    // If it's a JSON parsing error, provide more context
    if (error instanceof SyntaxError && error.message.includes("JSON")) {
      console.error("🚨 JSON PARSING ERROR DETECTED:");
      console.error(
        "This suggests the response from Gitea API is not valid JSON"
      );
      console.error("Common causes:");
      console.error("- Gitea server returned HTML error page instead of JSON");
      console.error("- Network connection interrupted");
      console.error("- Gitea server is down or misconfigured");
      console.error("- Authentication token is invalid");
      console.error("Check your Gitea server logs and configuration");
    }

    console.error("=====================================");

    return createSecureErrorResponse(error, "mirror-repo API", 500);
  }
};
