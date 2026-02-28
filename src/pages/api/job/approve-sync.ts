import type { APIRoute } from "astro";
import { db, configs, repositories } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { repoStatusEnum } from "@/types/Repository";
import { syncGiteaRepo } from "@/lib/gitea";
import { repositoryVisibilityEnum } from "@/types/Repository";
import { createMirrorJob } from "@/lib/helpers";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

/**
 * POST /api/job/approve-sync
 *
 * Approves or dismisses a repository whose sync was blocked because a
 * force-push was detected upstream (status = "pending-approval").
 *
 * Body:
 *   repositoryId: string   – the repository to approve/dismiss
 *   action: "approve" | "dismiss"
 *     - "approve" → immediately triggers a sync (bypassing force-push detection)
 *     - "dismiss"  → resets the repo status back to "mirrored" without syncing
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = await request.json();
    const { repositoryId, action } = body as {
      repositoryId?: string;
      action?: string;
    };

    if (!repositoryId || typeof repositoryId !== "string") {
      return jsonResponse({
        data: { success: false, error: "repositoryId is required" },
        status: 400,
      });
    }

    if (action !== "approve" && action !== "dismiss") {
      return jsonResponse({
        data: {
          success: false,
          error: 'action must be "approve" or "dismiss"',
        },
        status: 400,
      });
    }

    // Fetch the repository – must belong to the authenticated user
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.id, repositoryId),
          eq(repositories.userId, userId),
        ),
      )
      .limit(1);

    if (!repo) {
      return jsonResponse({
        data: { success: false, error: "Repository not found" },
        status: 404,
      });
    }

    if (repo.status !== "pending-approval") {
      return jsonResponse({
        data: {
          success: false,
          error: `Repository status is "${repo.status}", not "pending-approval". No action needed.`,
        },
        status: 409,
      });
    }

    // ── Dismiss ──────────────────────────────────────────────────────────
    if (action === "dismiss") {
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("mirrored"),
          updatedAt: new Date(),
          errorMessage: null,
        })
        .where(eq(repositories.id, repositoryId));

      await createMirrorJob({
        userId,
        repositoryId: repo.id,
        repositoryName: repo.name,
        message: `Force-push block dismissed for ${repo.name}`,
        details:
          "The force-push warning was dismissed by the user. The repository will not be synced until the next scheduled run.",
        status: "synced",
      });

      return jsonResponse({
        data: {
          success: true,
          message: `Force-push block dismissed for ${repo.name}. Status reset to mirrored.`,
        },
        status: 200,
      });
    }

    // ── Approve ──────────────────────────────────────────────────────────
    // First reset the status so the sync flow doesn't reject the repo
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("syncing"),
        updatedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(repositories.id, repositoryId));

    await createMirrorJob({
      userId,
      repositoryId: repo.id,
      repositoryName: repo.name,
      message: `Force-push approved for ${repo.name} – syncing now`,
      details:
        "The user approved the sync despite a force-push being detected. Sync is proceeding.",
      status: "syncing",
    });

    // Fetch the user config
    const [config] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    if (!config) {
      return jsonResponse({
        data: { success: false, error: "No configuration found for user" },
        status: 404,
      });
    }

    // Build a temporary config override that forces forcePushAction to "allow"
    // so the sync does not re-detect and re-block.
    const configOverride = {
      ...config,
      giteaConfig: {
        ...config.giteaConfig,
        forcePushAction: "allow" as const,
      },
    };

    // Fire and forget the actual sync in the background
    setTimeout(async () => {
      try {
        const repoData = {
          ...repo,
          status: repoStatusEnum.parse("syncing"),
          organization: repo.organization ?? undefined,
          lastMirrored: repo.lastMirrored ?? undefined,
          errorMessage: repo.errorMessage ?? undefined,
          forkedFrom: repo.forkedFrom ?? undefined,
          visibility: repositoryVisibilityEnum.parse(repo.visibility),
          mirroredLocation: repo.mirroredLocation || "",
        };

        await syncGiteaRepo({
          config: configOverride,
          repository: repoData,
        });

        console.log(
          `[ApproveSync] Successfully synced ${repo.name} after force-push approval`,
        );
      } catch (err) {
        console.error(
          `[ApproveSync] Failed to sync ${repo.name} after approval:`,
          err,
        );
      }
    }, 0);

    return jsonResponse({
      data: {
        success: true,
        message: `Sync approved and started for ${repo.name}.`,
      },
      status: 200,
    });
  } catch (error) {
    return createSecureErrorResponse(error, "approve-sync", 500);
  }
};
