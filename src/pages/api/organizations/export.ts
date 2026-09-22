import type { APIRoute } from "astro";
import { eq, sql } from "drizzle-orm";
import { db, organizations } from "@/lib/db";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { toCsv } from "@/lib/utils/csv";

/**
 * The exported organization columns, in the order they appear in the file. It
 * is the organizations table without the internal fields: the ids, the avatar
 * URL and the mirror option overrides (#428).
 */
const organizationExportSelection = {
  name: organizations.name,
  membershipRole: organizations.membershipRole,
  isIncluded: organizations.isIncluded,
  destinationOrg: organizations.destinationOrg,
  status: organizations.status,
  repositoryCount: organizations.repositoryCount,
  publicRepositoryCount: organizations.publicRepositoryCount,
  privateRepositoryCount: organizations.privateRepositoryCount,
  forkRepositoryCount: organizations.forkRepositoryCount,
  lastMirrored: organizations.lastMirrored,
  errorMessage: organizations.errorMessage,
  createdAt: organizations.createdAt,
  updatedAt: organizations.updatedAt,
};

export const ORGANIZATION_EXPORT_COLUMNS = Object.keys(
  organizationExportSelection
) as (keyof typeof organizationExportSelection)[];

export function organizationExportFilename(now: Date): string {
  return `gitea-mirror-organizations-${now.toISOString().slice(0, 10)}.csv`;
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const rows = await db
      .select(organizationExportSelection)
      .from(organizations)
      .where(eq(organizations.userId, authResult.userId))
      .orderBy(sql`${organizations.name} COLLATE NOCASE`);

    return new Response(toCsv(rows, ORGANIZATION_EXPORT_COLUMNS), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${organizationExportFilename(new Date())}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "organizations CSV export", 500);
  }
};
