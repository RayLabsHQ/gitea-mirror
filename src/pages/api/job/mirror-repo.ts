import type { APIRoute } from "astro";
import type { MirrorRepoRequest, MirrorRepoResponse } from "@/types/mirror";
import { db, configs, repositories } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { repositoryVisibilityEnum, repoStatusEnum } from "@/types/Repository";
import {
  mirrorGithubRepoToGitea,
  mirrorGitHubOrgRepoToGiteaOrg,
} from "@/lib/gitea";
import { createGitHubClient } from "@/lib/github";
import { processWithResilience } from "@/lib/utils/concurrency";
import { v4 as uuidv4 } from "uuid";

export const POST: APIRoute = async ({ request }) => {
  try {
    const body: MirrorRepoRequest = await request.json();
    const { userId, repositoryIds } = body;

    if (!userId || !repositoryIds || !Array.isArray(repositoryIds)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "userId and repositoryIds are required.",
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
      .where(inArray(repositories.id, repositoryIds));

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

      // Create a single Octokit instance to be reused
      const octokit = createGitHubClient(config.githubConfig.token);

      // Define the concurrency limit - adjust based on API rate limits
      const CONCURRENCY_LIMIT = 3;

      // Generate a batch ID to group related repositories
      const batchId = uuidv4();

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

          // Mirror the repository based on whether it's in an organization
          if (repo.organization && config.githubConfig.preserveOrgStructure) {
            await mirrorGitHubOrgRepoToGiteaOrg({
              config,
              octokit,
              orgName: repo.organization,
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
          batchId,
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

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error ? error.message : "An unknown error occurred",
        errorType: error?.constructor?.name || "Unknown",
        timestamp: new Date().toISOString(),
        troubleshooting:
          error instanceof SyntaxError && error.message.includes("JSON")
            ? "JSON parsing error detected. Check Gitea server status and logs. Ensure Gitea is returning valid JSON responses."
            : "Check application logs for more details",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
