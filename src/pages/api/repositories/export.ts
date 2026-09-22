import type { APIRoute } from "astro";
import { eq, sql } from "drizzle-orm";
import { db, repositories } from "@/lib/db";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { toCsv } from "@/lib/utils/csv";

/**
 * The exported repository columns, in the order they appear in the file. It
 * is the repositories table without the internal fields: the ids, the
 * metadata sync state and the mirror option overrides (#428).
 */
const repositoryExportSelection = {
  name: repositories.name,
  fullName: repositories.fullName,
  url: repositories.url,
  cloneUrl: repositories.cloneUrl,
  owner: repositories.owner,
  organization: repositories.organization,
  sourceProvider: repositories.sourceProvider,
  sourceUrl: repositories.sourceUrl,
  destinationProvider: repositories.destinationProvider,
  destinationUrl: repositories.destinationUrl,
  destinationOrg: repositories.destinationOrg,
  mirroredLocation: repositories.mirroredLocation,
  visibility: repositories.visibility,
  isPrivate: repositories.isPrivate,
  isForked: repositories.isForked,
  forkedFrom: repositories.forkedFrom,
  isStarred: repositories.isStarred,
  isArchived: repositories.isArchived,
  hasLFS: repositories.hasLFS,
  hasSubmodules: repositories.hasSubmodules,
  hasIssues: repositories.hasIssues,
  language: repositories.language,
  description: repositories.description,
  defaultBranch: repositories.defaultBranch,
  size: repositories.size,
  status: repositories.status,
  lastMirrored: repositories.lastMirrored,
  errorMessage: repositories.errorMessage,
  importedAt: repositories.importedAt,
  createdAt: repositories.createdAt,
  updatedAt: repositories.updatedAt,
};

export const REPOSITORY_EXPORT_COLUMNS = Object.keys(
  repositoryExportSelection
) as (keyof typeof repositoryExportSelection)[];

export function repositoryExportFilename(now: Date): string {
  return `gitea-mirror-repositories-${now.toISOString().slice(0, 10)}.csv`;
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const rows = await db
      .select(repositoryExportSelection)
      .from(repositories)
      .where(eq(repositories.userId, authResult.userId))
      .orderBy(sql`${repositories.fullName} COLLATE NOCASE`);

    return new Response(toCsv(rows, REPOSITORY_EXPORT_COLUMNS), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${repositoryExportFilename(new Date())}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "repositories CSV export", 500);
  }
};
