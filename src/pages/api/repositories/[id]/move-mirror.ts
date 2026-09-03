import type { APIRoute } from "astro";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configs, repositories } from "@/lib/db";
import type { Repository } from "@/lib/db/schema";
import type { Config } from "@/types/config";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { getGiteaRepoOwnerAsync } from "@/lib/gitea";
import { moveMirror } from "@/lib/destination-transfer-service";
import { MoveMirrorError, OWNER_NAME_PATTERN } from "@/lib/destination-transfer";

const bodySchema = z.object({
  destinationOrg: z.string().trim().max(100).nullable().optional(),
});

/**
 * Change a repository's destination and move its mirror there (issue #400).
 *
 * `destinationOrg` names the new owner; `null` removes the override and
 * moves the mirror back to where the strategy puts it. The mirror is
 * transferred on the destination (Gitea or Forgejo) before the row is
 * updated, so a refused transfer changes nothing. PATCH /api/repositories/:id
 * remains the way to change the label without touching the destination.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const repoId = params.id;
    if (!repoId) {
      return jsonResponse({ data: { success: false, error: "Repository ID is required" }, status: 400 });
    }

    const raw = await request.text();
    let parsedBody: unknown = {};
    if (raw.trim()) {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        return jsonResponse({ data: { success: false, error: "Body must be JSON" }, status: 400 });
      }
    }
    const parsed = bodySchema.safeParse(parsedBody);
    if (!parsed.success) {
      return jsonResponse({
        data: { success: false, error: "destinationOrg must be a string or null" },
        status: 400,
      });
    }
    const destinationOrg = parsed.data.destinationOrg || null;
    if (destinationOrg && !OWNER_NAME_PATTERN.test(destinationOrg)) {
      return jsonResponse({
        data: {
          success: false,
          error: "The destination owner may only contain letters, digits, dots, dashes and underscores",
        },
        status: 400,
      });
    }

    const [row] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.userId, userId)))
      .limit(1);
    if (!row) {
      return jsonResponse({ data: { success: false, error: "Repository not found" }, status: 404 });
    }
    const repository = row as Repository;

    const [config] = await db
      .select()
      .from(configs)
      .where(and(eq(configs.userId, userId), eq(configs.isActive, true)))
      .limit(1);
    if (!config) {
      return jsonResponse({ data: { success: false, error: "No active configuration found" }, status: 404 });
    }
    if (!config.giteaConfig?.url || !config.giteaConfig?.token || !config.giteaConfig?.defaultOwner) {
      return jsonResponse({
        data: {
          success: false,
          error: "Configure the destination URL, username and token before moving mirrors",
        },
        status: 400,
      });
    }

    // With the override removed, the mirror goes where the strategy (and an
    // organization override, if any) would put it.
    const newOwner =
      destinationOrg ??
      (await getGiteaRepoOwnerAsync({
        config: config as unknown as Partial<Config>,
        repository: { ...repository, destinationOrg: null },
      }));

    const transfer = await moveMirror({
      userId,
      config: config as unknown as Partial<Config>,
      repository,
      newOwner,
    });

    await db
      .update(repositories)
      .set({ destinationOrg, updatedAt: new Date() })
      .where(and(eq(repositories.id, repoId), eq(repositories.userId, userId)));

    const [updated] = await db
      .select({ destinationOrg: repositories.destinationOrg, mirroredLocation: repositories.mirroredLocation })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    return jsonResponse({
      data: {
        success: true,
        destinationOrg: updated?.destinationOrg ?? destinationOrg,
        mirroredLocation: updated?.mirroredLocation ?? repository.mirroredLocation ?? "",
        transfer,
      },
    });
  } catch (error) {
    if (error instanceof MoveMirrorError) {
      return jsonResponse({
        data: { success: false, error: error.message, code: error.code },
        status: error.status,
      });
    }
    return createSecureErrorResponse(error, "Move mirror", 500);
  }
};
