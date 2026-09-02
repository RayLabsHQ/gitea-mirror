import type { APIRoute } from "astro";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configs } from "@/lib/db";
import type { Config } from "@/types/config";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { reconcileDestination } from "@/lib/destination-reconcile-service";

const bodySchema = z.object({
  dryRun: z.boolean().optional().default(true),
  adoptUntracked: z.boolean().optional().default(false),
  resetMissing: z.boolean().optional().default(false),
});

/**
 * Compare the destination with the repository database (issue #284).
 *
 * Always computes the report. With `dryRun: false`, `adoptUntracked` creates
 * rows for mirrors the database does not know about and `resetMissing`
 * sends rows whose mirror is gone back to `imported`. Nothing is deleted or
 * archived here; the cleanup service keeps its own rules.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const raw = await request.text();
    let parsedBody: unknown = {};
    if (raw.trim()) {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        return jsonResponse({
          data: { success: false, error: "Body must be JSON" },
          status: 400,
        });
      }
    }
    const parsed = bodySchema.safeParse(parsedBody);
    if (!parsed.success) {
      return jsonResponse({
        data: { success: false, error: "dryRun, adoptUntracked and resetMissing must be booleans" },
        status: 400,
      });
    }

    const [config] = await db
      .select()
      .from(configs)
      .where(and(eq(configs.userId, userId), eq(configs.isActive, true)))
      .limit(1);

    if (!config) {
      return jsonResponse({
        data: { success: false, error: "No active configuration found" },
        status: 404,
      });
    }

    if (!config.giteaConfig?.url || !config.giteaConfig?.token || !config.giteaConfig?.defaultOwner) {
      return jsonResponse({
        data: {
          success: false,
          error: "Configure the destination URL, username and token before reconciling",
        },
        status: 400,
      });
    }

    const result = await reconcileDestination(config as unknown as Config, parsed.data);

    return jsonResponse({
      data: { success: true, ...result },
      status: 200,
    });
  } catch (error) {
    return createSecureErrorResponse(error, "destination reconcile", 500);
  }
};
