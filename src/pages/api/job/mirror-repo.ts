import type { APIRoute } from "astro";
import type { MirrorRepoRequest, MirrorRepoResponse } from "@/types/mirror";
import { db, configs, repositories } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { repositoryVisibilityEnum, repoStatusEnum } from "@/types/Repository";
import {
  mirrorGithubRepoToGitea,
  mirrorGitHubOrgRepoToGiteaOrg,
} from "@/lib/gitea";
import PQueue from "p-queue";
import { createGitHubClient } from "@/lib/github";

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

    // Start async mirroring in background with limited concurrency
    setTimeout(async () => {
      const queue = new PQueue({ concurrency: 3 });
      for (const repo of repos) {
        queue.add(async () => {
          if (!config.githubConfig.token) {
            throw new Error("GitHub token is missing.");
          }

          const octokit = createGitHubClient(config.githubConfig.token);

          try {
            if (repo.organization && config.githubConfig.preserveOrgStructure) {
              await mirrorGitHubOrgRepoToGiteaOrg({
                config,
                octokit,
                orgName: repo.organization,
                repository: {
                  ...repo,
                  status: repoStatusEnum.parse("imported"),
                  organization: repo.organization ?? undefined,
                  lastMirrored: repo.lastMirrored ?? undefined,
                  errorMessage: repo.errorMessage ?? undefined,
                  forkedFrom: repo.forkedFrom ?? undefined,
                  visibility: repositoryVisibilityEnum.parse(repo.visibility),
                  mirroredLocation: repo.mirroredLocation || "",
                },
              });
            } else {
              await mirrorGithubRepoToGitea({
                octokit,
                repository: {
                  ...repo,
                  status: repoStatusEnum.parse("imported"),
                  organization: repo.organization ?? undefined,
                  lastMirrored: repo.lastMirrored ?? undefined,
                  errorMessage: repo.errorMessage ?? undefined,
                  forkedFrom: repo.forkedFrom ?? undefined,
                  visibility: repositoryVisibilityEnum.parse(repo.visibility),
                  mirroredLocation: repo.mirroredLocation || "",
                },
                config,
              });
            }
          } catch (error) {
            console.error(`Mirror failed for repo ${repo.name}:`, error);
          }
        });
      }
      await queue.onIdle();
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
    console.error("Error mirroring repositories:", error);
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error ? error.message : "An unknown error occurred",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
