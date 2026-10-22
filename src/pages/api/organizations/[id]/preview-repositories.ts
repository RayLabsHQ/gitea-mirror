import type { APIRoute } from "astro";
import { and, asc, eq } from "drizzle-orm";
import { db, organizations, repositories } from "@/lib/db";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";

/**
 * Cap on how many repositories a single organization override can preview. The
 * list only feeds a dropdown, so it is trimmed rather than left to grow without
 * bound; the newest names are the ones a user is most likely to reach for.
 */
const MAX_PREVIEW_REPOSITORIES = 200;

/**
 * List the repositories an organization override covers, so its release-rule
 * dialog can preview one of them.
 *
 * A global rule has no single repository and a repository override names one,
 * but an organization rule fans out over every repository the organization
 * mirrors. This route hands the rule editor the repositories it can offer in a
 * picker; the per-repository releases then come from the existing
 * /api/repositories/:id/releases route once one is chosen.
 *
 * GET /api/organizations/:id/preview-repositories
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const orgId = params.id;
    if (!orgId) {
      return jsonResponse({ data: { success: false, error: "Organization ID is required" }, status: 400 });
    }

    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.userId, userId)))
      .limit(1);
    if (!org) {
      return jsonResponse({ data: { success: false, error: "Organization not found" }, status: 404 });
    }

    // A repository belongs to the organization when its `organization` column
    // carries the organization name, the same link the mirror paths use.
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        owner: repositories.owner,
      })
      .from(repositories)
      .where(and(eq(repositories.userId, userId), eq(repositories.organization, org.name)))
      .orderBy(asc(repositories.name))
      .limit(MAX_PREVIEW_REPOSITORIES);

    return jsonResponse({
      data: {
        success: true,
        organization: org.name,
        repositories: rows.map((row) => ({
          id: row.id,
          label: `${row.owner}/${row.name}`,
        })),
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "List organization preview repositories", 500);
  }
};
