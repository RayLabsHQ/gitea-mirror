import type { APIRoute } from "astro";
import { asc, eq } from "drizzle-orm";
import { db, repositories } from "@/lib/db";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";

/**
 * Cap on how many repositories the global preview picker offers. The list only
 * feeds a dropdown, so it is trimmed rather than left to grow without bound.
 */
const MAX_PREVIEW_REPOSITORIES = 200;

/**
 * List the account's repositories so the global release-rule dialog can
 * preview its draft patterns against one of them.
 *
 * Global rules hit every repository, so a typo there costs the most; the same
 * picker the organization dialog uses applies here, just over the whole
 * account. The per-repository releases then come from the existing
 * /api/repositories/:id/releases route once one is chosen.
 *
 * GET /api/repositories/preview-repositories
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        owner: repositories.owner,
      })
      .from(repositories)
      .where(eq(repositories.userId, userId))
      .orderBy(asc(repositories.name))
      .limit(MAX_PREVIEW_REPOSITORIES);

    return jsonResponse({
      data: {
        success: true,
        truncated: rows.length >= MAX_PREVIEW_REPOSITORIES,
        repositories: rows.map((row) => ({
          id: row.id,
          label: `${row.owner}/${row.name}`,
        })),
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "List preview repositories", 500);
  }
};
