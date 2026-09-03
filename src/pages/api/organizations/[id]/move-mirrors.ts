import type { APIRoute } from "astro";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configs, organizations } from "@/lib/db";
import type { Config } from "@/types/config";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { moveOrganizationMirrors } from "@/lib/destination-transfer-service";
import { MoveMirrorError, OWNER_NAME_PATTERN } from "@/lib/destination-transfer";

const bodySchema = z.object({
  destinationOrg: z.string().trim().max(100).nullable().optional(),
  dryRun: z.boolean().optional().default(true),
});

/**
 * Change an organization's destination and move its mirrors there (issue
 * #400). A dry run (the default) answers with the plan: which repositories
 * would move and which are skipped, so the client can ask for confirmation.
 * With `dryRun: false` each mirrored repository without its own destination
 * is transferred on the destination, and the organization's `destinationOrg`
 * is written afterwards even when some transfers failed; those are listed
 * with their reason and keep syncing where they are.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const orgId = params.id;
    if (!orgId) {
      return jsonResponse({ data: { success: false, error: "Organization ID is required" }, status: 400 });
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
        data: { success: false, error: "destinationOrg must be a string or null and dryRun a boolean" },
        status: 400,
      });
    }
    const destinationOrg = parsed.data.destinationOrg || null;
    const dryRun = parsed.data.dryRun;
    if (destinationOrg && !OWNER_NAME_PATTERN.test(destinationOrg)) {
      return jsonResponse({
        data: {
          success: false,
          error: "The destination owner may only contain letters, digits, dots, dashes and underscores",
        },
        status: 400,
      });
    }

    const [organization] = await db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.userId, userId)))
      .limit(1);
    if (!organization) {
      return jsonResponse({ data: { success: false, error: "Organization not found" }, status: 404 });
    }

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

    const result = await moveOrganizationMirrors({
      userId,
      config: config as unknown as Partial<Config>,
      organization: { id: organization.id, name: organization.name },
      destinationOrg,
      dryRun,
    });

    if (!dryRun) {
      await db
        .update(organizations)
        .set({ destinationOrg, updatedAt: new Date() })
        .where(and(eq(organizations.id, orgId), eq(organizations.userId, userId)));
    }

    return jsonResponse({
      data: {
        success: true,
        destinationOrg: dryRun ? (organization.destinationOrg ?? null) : destinationOrg,
        ...result,
      },
    });
  } catch (error) {
    if (error instanceof MoveMirrorError) {
      return jsonResponse({
        data: { success: false, error: error.message, code: error.code },
        status: error.status,
      });
    }
    return createSecureErrorResponse(error, "Move organization mirrors", 500);
  }
};
