import type { APIRoute } from "astro";
import { db, repositories, configs, organizations, sources } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { resolveDestinationOwner } from "@/lib/gitea";
import type { Repository } from "@/lib/db/schema";
import {
  repositoryVisibilityEnum,
  repoStatusEnum,
  type RepositoryApiResponse,
} from "@/types/Repository";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // Fetch the user's active configuration
    const [config] = await db
      .select()
      .from(configs)
      .where(and(eq(configs.userId, userId), eq(configs.isActive, true)));

    if (!config) {
      return jsonResponse({
        data: {
          success: false,
          error: "No active configuration found for this user",
        },
        status: 404,
      });
    }

    const githubConfig = config.githubConfig as {
      mirrorStarred: boolean;
      skipForks: boolean;
      privateRepositories: boolean;
    };

    // Build query conditions based on config
    const conditions = [eq(repositories.userId, userId)];

    // Note: We show ALL repositories in the list
    // The mirrorStarred and privateRepositories flags only control what gets mirrored,
    // not what's displayed in the repository list
    // Only skipForks is used for filtering the display since forked repos are often noise

    const rawRepositories = await db
      .select()
      .from(repositories)
      .where(and(...conditions))
      .orderBy(sql`${repositories.importedAt} DESC`, sql`name COLLATE NOCASE`);

    // Organization-level destination overrides. A repository without its own
    // destinationOrg follows its organization's, so the list ships the map and
    // the destination column names that instead of the strategy default (#416).
    const orgDestinationRows = await db
      .select({
        name: organizations.name,
        normalizedName: organizations.normalizedName,
        destinationOrg: organizations.destinationOrg,
      })
      .from(organizations)
      .where(eq(organizations.userId, userId));

    const organizationDestinations: Record<string, string> = {};
    const organizationDestinationByName = new Map<string, string>();
    for (const row of orgDestinationRows) {
      if (!row.destinationOrg) continue;
      organizationDestinations[row.name] = row.destinationOrg;
      organizationDestinationByName.set(row.name, row.destinationOrg);
      organizationDestinationByName.set(row.normalizedName, row.destinationOrg);
    }

    // The repository's own source username is part of the strategy fallback for
    // personal repos, so resolve it up front instead of per row.
    const sourceRows = await db
      .select({ id: sources.id, username: sources.username })
      .from(sources)
      .where(eq(sources.userId, userId));
    const sourceUsernames = new Map(sourceRows.map((row) => [row.id, row.username]));

    // The real destination each row mirrors into. This is what the repositories
    // page filters by; `organizationDestinations` above remains for the
    // destination column's existing per-organization fallback (#416).
    const destinationOwners: Record<string, string> = {};
    const repositoriesWithDestination = rawRepositories.map((repo) => {
      const organizationDestination = repo.organization
        ? organizationDestinationByName.get(repo.organization) ??
          organizationDestinationByName.get(repo.organization.toLowerCase())
        : undefined;

      try {
        destinationOwners[repo.id] = resolveDestinationOwner({
          config: {
            userId,
            githubConfig: config.githubConfig as any,
            giteaConfig: config.giteaConfig as any,
          },
          repository: repo as unknown as Repository,
          organizationDestination,
          sourceUsername: repo.sourceId
            ? sourceUsernames.get(repo.sourceId)
            : undefined,
        });
      } catch (error) {
        // A row that cannot be resolved still belongs in the list; it simply
        // has no destination filter value.
        console.warn(
          `[Repositories] Could not resolve destination owner for ${repo.fullName}:`,
          error
        );
      }

      return {
        ...repo,
        organization: repo.organization ?? undefined,
        lastMirrored: repo.lastMirrored ?? undefined,
        errorMessage: repo.errorMessage ?? undefined,
        forkedFrom: repo.forkedFrom ?? undefined,
        status: repoStatusEnum.parse(repo.status),
        visibility: repositoryVisibilityEnum.parse(repo.visibility),
      };
    });

    const response: RepositoryApiResponse = {
      success: true,
      message: "Repositories fetched successfully",
      organizationDestinations,
      destinationOwners,
      repositories: repositoriesWithDestination,
    };

    return jsonResponse({
      data: response,
      status: 200,
    });
  } catch (error) {
    return createSecureErrorResponse(error, "repositories fetch", 500);
  }
};
