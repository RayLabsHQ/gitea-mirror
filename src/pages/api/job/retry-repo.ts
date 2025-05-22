import type { APIRoute } from "astro";
import { db, configs, repositories } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { getGiteaRepoOwner, isRepoPresentInGitea } from "@/lib/gitea";
import {
  mirrorGithubRepoToGitea,
  mirrorGitHubOrgRepoToGiteaOrg,
  syncGiteaRepo,
} from "@/lib/gitea";
import { createGitHubClient } from "@/lib/github";
import { repoStatusEnum, repositoryVisibilityEnum } from "@/types/Repository";
import type { RetryRepoRequest, RetryRepoResponse } from "@/types/retry";
import PQueue from "p-queue";

export const POST: APIRoute = async ({ request }) => {
  try {
    const body: RetryRepoRequest = await request.json();
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
      .where(inArray(repositories.id, repositoryIds));

    if (!repos.length) {
      return new Response(
        JSON.stringify({ error: "No repositories found for the given IDs." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Start background retry with limited concurrency
    setTimeout(async () => {
      const queue = new PQueue({ concurrency: 3 });
      for (const repo of repos) {
        queue.add(async () => {
          try {
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
            };

            let owner = getGiteaRepoOwner({
              config,
              repository: repoData,
            });

            const present = await isRepoPresentInGitea({
              config,
              owner,
              repoName: repo.name,
            });

            if (present) {
              await syncGiteaRepo({ config, repository: repoData });
              console.log(`Synced existing repo: ${repo.name}`);
            } else {
              if (!config.githubConfig.token) {
                throw new Error("GitHub token is missing.");
              }

              console.log(`Importing repo: ${repo.name} ${owner}`);

              const octokit = createGitHubClient(config.githubConfig.token);
              if (
                repo.organization &&
                config.githubConfig.preserveOrgStructure
              ) {
                await mirrorGitHubOrgRepoToGiteaOrg({
                  config,
                  octokit,
                  orgName: repo.organization,
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
          } catch (err) {
            console.error(`Failed to retry repo ${repo.name}:`, err);
          }
        });
      }
      await queue.onIdle();
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
    console.error("Error retrying repo:", err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "An unknown error occurred",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
