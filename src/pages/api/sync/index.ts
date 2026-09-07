import type { APIRoute } from "astro";
import { db, organizations, repositories, configs } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createMirrorJob } from "@/lib/helpers";
import { SOURCE_PROVIDER_LABELS } from "@/lib/source-providers";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import {
  mergeGitReposPreferStarred,
  normalizeGitRepoToInsert,
  calcBatchSizeForInsert,
} from "@/lib/repo-utils";
import { loadOrganizationForkPolicies } from "@/lib/utils/mirror-overrides";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { isMirrorableGitHubRepo } from "@/lib/repo-eligibility";

export const POST: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAuthenticatedUserId({ request, locals });
  if ("response" in authResult) return authResult.response;
  const userId = authResult.userId;

  try {
    // Prefer active and most-recently-updated config to avoid picking a stale
    // inactive stub when multiple rows exist (see issue #271).
    const [config] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    if (!config) {
      return jsonResponse({
        data: { error: "No configuration found for this user" },
        status: 404,
      });
    }

    // Every enabled source the user connected, oldest first (the first entry
    // is the primary source). A source without a token still lists public
    // repositories through its provider. Configs written outside the sources
    // API get their first source row seeded here.
    const { listSources, ensureSourcesFromConfig } = await import("@/lib/sources");
    const { createSourceProviderFromSource } = await import("@/lib/source-providers");
    await ensureSourcesFromConfig(userId);
    const sources = (await listSources(userId)).filter((source) => source.enabled);

    if (sources.length === 0) {
      return jsonResponse({
        data: { error: "No enabled source is configured for this user" },
        status: 400,
      });
    }

    // Load ignored orgs from the DB so we can skip them during import
    const ignoredOrgRows = await db
      .select({ normalizedName: organizations.normalizedName })
      .from(organizations)
      .where(and(eq(organizations.userId, userId), eq(organizations.status, "ignored")));
    const ignoredOrgNames = new Set(ignoredOrgRows.map((o) => o.normalizedName));

    // Per-organization fork pins, so an org opted out of forks is not
    // re-imported by this bulk pass even when the global switch is off.
    // Loaded once; the pins apply to every source.
    const orgForkOverrides = await loadOrganizationForkPolicies({ userId });

    let totalInsertedRepos = 0;
    let totalInsertedOrgs = 0;
    let totalRecoveredOrgs = 0;
    let totalSkippedDisabled = 0;
    const failedOrgNames: string[] = [];
    const failedSourceNames: string[] = [];

    for (const source of sources) {
      try {
        const sourceProvider = createSourceProviderFromSource(source, { userId });
        const sourceLabel = SOURCE_PROVIDER_LABELS[sourceProvider.kind];

        // Fetch source data in parallel
        const [basicAndForkedRepos, starredRepos, orgResult] = await Promise.all([
          sourceProvider.listRepositories(config, { orgForkOverrides }),
          config.githubConfig?.includeStarred
            ? sourceProvider.listStarredRepositories(config)
            : Promise.resolve([]),
          sourceProvider.listOrganizations(config, ignoredOrgNames),
        ]);
        const { organizations: gitOrgs, failedOrgs } = orgResult;

        // Merge and de-duplicate by fullName, preferring starred variant when duplicated
        const allGithubRepos = mergeGitReposPreferStarred(basicAndForkedRepos, starredRepos);
        const mirrorableGithubRepos = allGithubRepos.filter(isMirrorableGitHubRepo);
        totalSkippedDisabled += allGithubRepos.length - mirrorableGithubRepos.length;

        // Prepare full list of repos and orgs. The normalizer stamps the source
        // provider and URL on every row; sourceId ties the row to this source.
        const newRepos = mirrorableGithubRepos.map((repo) =>
          normalizeGitRepoToInsert(repo, { userId, configId: config.id, sourceId: source.id })
        );

        const newOrgs = gitOrgs.map((org) => ({
          id: uuidv4(),
          userId,
          configId: config.id,
          name: org.name,
          normalizedName: org.name.toLowerCase(),
          avatarUrl: org.avatarUrl,
          membershipRole: org.membershipRole,
          isIncluded: false,
          status: org.status,
          repositoryCount: org.repositoryCount,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));

        // Prepare failed org records for DB insertion
        const failedOrgRecords = failedOrgs.map((org) => ({
          id: uuidv4(),
          userId,
          configId: config.id,
          name: org.name,
          normalizedName: org.name.toLowerCase(),
          avatarUrl: org.avatarUrl,
          membershipRole: "member" as const,
          isIncluded: false,
          status: "failed" as const,
          errorMessage: org.reason,
          repositoryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));

        let insertedRepos: typeof newRepos = [];
        let insertedOrgs: typeof newOrgs = [];
        let insertedFailedOrgs: typeof failedOrgRecords = [];
        let recoveredOrgCount = 0;

        // Transaction to insert only new items
        await db.transaction(async (tx) => {
          const [existingRepos, existingOrgs] = await Promise.all([
            tx
              .select({
                normalizedFullName: repositories.normalizedFullName,
                sourceId: repositories.sourceId,
              })
              .from(repositories)
              .where(eq(repositories.userId, userId)),
            tx
              .select({ normalizedName: organizations.normalizedName, status: organizations.status })
              .from(organizations)
              .where(eq(organizations.userId, userId)),
          ]);

          // The same full name under two sources is two different repositories.
          const existingRepoKeys = new Set(
            existingRepos.map((r) => `${r.sourceId ?? ""}|${r.normalizedFullName}`)
          );
          const existingOrgMap = new Map(existingOrgs.map((o) => [o.normalizedName, o.status]));

          insertedRepos = newRepos.filter(
            (r) =>
              !existingRepoKeys.has(`${source.id}|${r.normalizedFullName}`) &&
              (!r.organization || !ignoredOrgNames.has(r.organization.toLowerCase()))
          );
          insertedOrgs = newOrgs.filter((o) => !existingOrgMap.has(o.normalizedName));

          // Update previously failed orgs that now succeeded
          const recoveredOrgs = newOrgs.filter(
            (o) => existingOrgMap.get(o.normalizedName) === "failed"
          );
          for (const org of recoveredOrgs) {
            await tx
              .update(organizations)
              .set({
                status: "imported",
                errorMessage: null,
                repositoryCount: org.repositoryCount,
                avatarUrl: org.avatarUrl,
                membershipRole: org.membershipRole,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(organizations.userId, userId),
                  eq(organizations.normalizedName, org.normalizedName),
                )
              );
          }
          recoveredOrgCount = recoveredOrgs.length;

          // Insert or update failed orgs (only update orgs already in "failed" state — don't overwrite good state)
          insertedFailedOrgs = failedOrgRecords.filter((o) => !existingOrgMap.has(o.normalizedName));
          const stillFailedOrgs = failedOrgRecords.filter(
            (o) => existingOrgMap.get(o.normalizedName) === "failed"
          );
          for (const org of stillFailedOrgs) {
            await tx
              .update(organizations)
              .set({
                errorMessage: org.errorMessage,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(organizations.userId, userId),
                  eq(organizations.normalizedName, org.normalizedName),
                )
              );
          }

          // Batch insert repositories to avoid SQLite parameter limit (dynamic by column count)
          const sample = newRepos[0];
          const columnCount = Object.keys(sample ?? {}).length || 1;
          const REPO_BATCH_SIZE = calcBatchSizeForInsert(columnCount);
          if (insertedRepos.length > 0) {
            for (let i = 0; i < insertedRepos.length; i += REPO_BATCH_SIZE) {
              const batch = insertedRepos.slice(i, i + REPO_BATCH_SIZE);
              await tx
                .insert(repositories)
                .values(batch)
                .onConflictDoNothing({
                  target: [repositories.userId, repositories.sourceId, repositories.normalizedFullName],
                });
            }
          }

          // Batch insert organizations (they have fewer fields, so we can use larger batches)
          const ORG_BATCH_SIZE = 100;
          const allNewOrgs = [...insertedOrgs, ...insertedFailedOrgs];
          if (allNewOrgs.length > 0) {
            for (let i = 0; i < allNewOrgs.length; i += ORG_BATCH_SIZE) {
              const batch = allNewOrgs.slice(i, i + ORG_BATCH_SIZE);
              await tx.insert(organizations).values(batch);
            }
          }
        });

        // Create mirror jobs only for newly inserted items
        const mirrorJobPromises = [
          ...insertedRepos.map((repo) =>
            createMirrorJob({
              userId,
              repositoryId: repo.id,
              repositoryName: repo.name,
              status: "imported",
              message: `Repository ${repo.name} fetched successfully`,
              details: `Repository ${repo.name} was fetched from ${sourceLabel}`,
            })
          ),
          ...insertedOrgs.map((org) =>
            createMirrorJob({
              userId,
              organizationId: org.id,
              organizationName: org.name,
              status: "imported",
              message: `Organization ${org.name} fetched successfully`,
              details: `Organization ${org.name} was fetched from ${sourceLabel}`,
            })
          ),
        ];

        await Promise.all(mirrorJobPromises);

        totalInsertedRepos += insertedRepos.length;
        totalInsertedOrgs += insertedOrgs.length;
        totalRecoveredOrgs += recoveredOrgCount;
        failedOrgNames.push(
          ...failedOrgs
            .filter((o) => !ignoredOrgNames.has(o.name.toLowerCase()))
            .map((o) => o.name)
        );
      } catch (sourceError) {
        console.error(`Sync failed for source ${source.name} (${source.id}):`, sourceError);
        failedSourceNames.push(source.name);
      }
    }

    if (sources.length > 0 && failedSourceNames.length === sources.length) {
      return createSecureErrorResponse(
        new Error("every enabled source failed to sync"),
        "source data sync",
        502
      );
    }

    return jsonResponse({
      data: {
        success: true,
        message: "Repositories and organizations synced successfully",
        newRepositories: totalInsertedRepos,
        newOrganizations: totalInsertedOrgs,
        skippedDisabledRepositories: totalSkippedDisabled,
        failedOrgs: failedOrgNames,
        failedSources: failedSourceNames,
        recoveredOrgs: totalRecoveredOrgs,
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "source data sync", 500);
  }
};
