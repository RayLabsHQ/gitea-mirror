import type { APIContext } from "astro";
import { db, organizations, repositories } from "@/lib/db";
import { eq, and, notInArray, sql } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { IN_FLIGHT_REPO_STATUSES } from "@/lib/stuck-status-recovery";

const validStatuses = ["imported", "mirroring", "mirrored", "failed", "ignored"] as const;
type OrganizationStatus = (typeof validStatuses)[number];

/**
 * Repository statuses an organization-level ignore leaves alone. Rows in
 * flight are locked by their status (see repo-status-claim.ts) and settle on
 * their own when the job finishes, a deletion is already on its way out, and
 * rows already ignored stay that way.
 */
const IGNORE_CASCADE_EXCLUDED_STATUSES = [...IN_FLIGHT_REPO_STATUSES, "deleting", "ignored"];

/**
 * Ignoring an organization also ignores its repositories, so the scheduler
 * stops syncing them (#429). Including it again restores the ones the ignore
 * touched: a repository that has been mirrored goes back to mirrored, one
 * that never was goes back to imported.
 */
async function cascadeOrganizationStatus(
  userId: string,
  organizationName: string,
  status: OrganizationStatus,
  now: Date
): Promise<number> {
  if (status === "ignored") {
    const changed = await db
      .update(repositories)
      .set({ status: "ignored", updatedAt: now })
      .where(
        and(
          eq(repositories.userId, userId),
          eq(repositories.organization, organizationName),
          notInArray(repositories.status, IGNORE_CASCADE_EXCLUDED_STATUSES)
        )
      )
      .returning({ id: repositories.id });
    return changed.length;
  }

  if (status === "imported") {
    const changed = await db
      .update(repositories)
      .set({
        status: sql`CASE WHEN ${repositories.lastMirrored} IS NOT NULL THEN 'mirrored' ELSE 'imported' END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(repositories.userId, userId),
          eq(repositories.organization, organizationName),
          eq(repositories.status, "ignored")
        )
      )
      .returning({ id: repositories.id });
    return changed.length;
  }

  return 0;
}

export async function PATCH({ params, request, locals }: APIContext) {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const { id } = params;
    const body = await request.json();
    const { status } = body;
    const cascade = body.cascade === true;

    if (!id) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Organization ID is required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Validate the status
    if (!validStatuses.includes(status)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const now = new Date();

    // Update the organization status
    const [updatedOrg] = await db
      .update(organizations)
      .set({
        status,
        updatedAt: now,
      })
      .where(
        and(
          eq(organizations.id, id),
          eq(organizations.userId, userId)
        )
      )
      .returning();

    if (!updatedOrg) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Organization not found or you don't have permission to update it",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const repositoriesChanged = cascade
      ? await cascadeOrganizationStatus(userId, updatedOrg.name, status, now)
      : 0;

    return new Response(
      JSON.stringify({
        success: true,
        organization: updatedOrg,
        repositoriesChanged,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error);
  }
}
