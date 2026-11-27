import type { APIRoute } from "astro";
import { eq, sql } from "drizzle-orm";
import { db, configs, organizations, repositories } from "@/lib/db";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { decryptSourceToken, listSources } from "@/lib/sources";
import {
  buildSettingsExport,
  serializeSettingsExport,
  settingsExportFilename,
} from "@/lib/settings-export";

/**
 * GET /api/config/export (#587): the settings as a JSON file, without
 * credentials or run state. `?repositories=all` lists every tracked
 * repository instead of only the ones with a choice of their own.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // The same row the Configuration page shows (see GET /api/config).
    const [config] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    if (!config) {
      return new Response(
        JSON.stringify({ success: false, error: "There are no settings to export yet." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const [sources, organizationRows, repositoryRows] = await Promise.all([
      listSources(userId),
      db
        .select({
          name: organizations.name,
          sourceId: organizations.sourceId,
          isIncluded: organizations.isIncluded,
          status: organizations.status,
          destinationOrg: organizations.destinationOrg,
          mirrorOverrides: organizations.mirrorOverrides,
        })
        .from(organizations)
        .where(eq(organizations.userId, userId)),
      db
        .select({
          fullName: repositories.fullName,
          sourceId: repositories.sourceId,
          status: repositories.status,
          destinationOrg: repositories.destinationOrg,
          mirrorOverrides: repositories.mirrorOverrides,
        })
        .from(repositories)
        .where(eq(repositories.userId, userId)),
    ]);

    const allRepositories = new URL(request.url).searchParams.get("repositories") === "all";
    const body = serializeSettingsExport(
      buildSettingsExport({
        config,
        sources,
        organizations: organizationRows,
        repositories: repositoryRows,
        allRepositories,
        appVersion: process.env.npm_package_version,
        decryptToken: decryptSourceToken,
      })
    );

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${settingsExportFilename(new Date())}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "settings export", 500);
  }
};
