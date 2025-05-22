import type { APIRoute } from "astro";
import { db, configs, repositories } from "@/lib/db";
import { eq, or } from "drizzle-orm";
import { repoStatusEnum, repositoryVisibilityEnum } from "@/types/Repository";
import { isRepoPresentInGitea, syncGiteaRepo } from "@/lib/gitea";
import type {
  ScheduleSyncRepoRequest,
  ScheduleSyncRepoResponse,
} from "@/types/sync";
import PQueue from "p-queue";

export const POST: APIRoute = async ({ request }) => {
  try {
    const body: ScheduleSyncRepoRequest = await request.json();
    const { userId } = body;

    if (!userId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing userId in request body.",
          repositories: [],
        } satisfies ScheduleSyncRepoResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch config for the user
    const configResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    const config = configResult[0];

    if (!config || !config.githubConfig.token) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Config missing for the user or GitHub token not found.",
          repositories: [],
        } satisfies ScheduleSyncRepoResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch repositories with status 'mirrored' or 'synced'
    const repos = await db
      .select()
      .from(repositories)
      .where(
        eq(repositories.userId, userId) &&
          or(
            eq(repositories.status, "mirrored"),
            eq(repositories.status, "synced"),
            eq(repositories.status, "failed")
          )
      );

    if (!repos.length) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "No repositories found with status mirrored, synced or failed.",
          repositories: [],
        } satisfies ScheduleSyncRepoResponse),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Calculate nextRun and update lastRun and nextRun in the config
    const currentTime = new Date();
    const interval = config.scheduleConfig?.interval ?? 3600;
    const nextRun = new Date(currentTime.getTime() + interval * 1000);

    // Update the full giteaConfig object
    await db
      .update(configs)
      .set({
        scheduleConfig: {
          ...config.scheduleConfig,
          lastRun: currentTime,
          nextRun: nextRun,
        },
      })
      .where(eq(configs.userId, userId));

    // Start async sync in background with limited concurrency
    setTimeout(async () => {
      const queue = new PQueue({ concurrency: 3 });
      for (const repo of repos) {
        queue.add(async () => {
          try {
            // Only check Gitea presence if the repo failed previously
            if (repo.status === "failed") {
              const isPresent = await isRepoPresentInGitea({
                config,
                owner: repo.owner,
                repoName: repo.name,
              });

              if (!isPresent) {
                return; // skip if repo is not present in Gitea
              }
            }

            await syncGiteaRepo({
              config,
              repository: {
                ...repo,
                status: repoStatusEnum.parse(repo.status),
                organization: repo.organization ?? undefined,
                lastMirrored: repo.lastMirrored ?? undefined,
                errorMessage: repo.errorMessage ?? undefined,
                forkedFrom: repo.forkedFrom ?? undefined,
                visibility: repositoryVisibilityEnum.parse(repo.visibility),
              },
            });
          } catch (error) {
            console.error(`Sync failed for repo ${repo.name}:`, error);
          }
        });
      }
      await queue.onIdle();
    }, 0);

    const resPayload: ScheduleSyncRepoResponse = {
      success: true,
      message: "Sync job scheduled for eligible repositories.",
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

    return new Response(JSON.stringify(resPayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in scheduling sync:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error:
          error instanceof Error ? error.message : "An unknown error occurred",
        repositories: [],
      } satisfies ScheduleSyncRepoResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
