/**
 * Manual organization sync (issue #429).
 *
 * The organization card offers "Mirror Organization" only while an
 * organization has never been mirrored. Once it reads "Successfully
 * mirrored" there was no way to refresh it by hand: the user had to wait for
 * the scheduler or sync every repository one at a time. This module is the
 * by-hand version of what a scheduled run does for a single organization.
 * It re-discovers the organization's repositories from its source, mirrors
 * the ones that were never mirrored and syncs the ones that were, leaving
 * rows another run already owns alone.
 */

import type { Octokit } from "@octokit/rest";
import { and, eq } from "drizzle-orm";
import { db, organizations, repositories } from "@/lib/db";
import type { Config, Repository } from "@/lib/db/schema";
import { usesPushEngine } from "@/lib/destination-connection";
import { createGitHubClient, createPublicGitHubClient } from "@/lib/github";
import { createMirrorJob } from "@/lib/helpers";
import {
  decryptSourceToken,
  findSourceForOrganization,
  findSourceForRepository,
  listSources,
  resolveGitHubApiBaseUrl,
  type SourceRecord,
} from "@/lib/sources";
import { mirrorRepositoryToDestination, syncRepositoryOnDestination } from "@/lib/mirror-dispatch";
import { rediscoverRepositoriesForOrganization, type DiscoverableOrganization } from "@/lib/organization-discovery";
import { repoStatusEnum, repositoryVisibilityEnum } from "@/types/Repository";
import { processWithResilience } from "@/lib/utils/concurrency";
import { resolveOrganizationSkipForks } from "@/lib/utils/mirror-overrides";

const LOG_PREFIX = "[SyncOrg]";

/** Repository rows are processed a few at a time, as the other job routes do. */
const MIRROR_CONCURRENCY_LIMIT = 3;
const SYNC_CONCURRENCY_LIMIT = 5;

/** Statuses a manual organization sync mirrors for the first time. */
export const ORG_SYNC_MIRROR_STATUSES = ["imported"] as const;

/**
 * Statuses a manual organization sync refreshes on the destination. A failed
 * row is synced rather than re-created: its mirror usually exists and only
 * the metadata pass failed. Every other status is left alone, which is also
 * how rows another run owns ("mirroring", "syncing") are skipped.
 */
export const ORG_SYNC_SYNC_STATUSES = ["mirrored", "synced", "failed"] as const;

/** The organization fields a manual sync reads. */
export interface SyncableOrganization extends DiscoverableOrganization {
  id: string;
  name: string;
}

type RepositoryRow = typeof repositories.$inferSelect;

export interface OrganizationSyncPlan {
  /** Never mirrored, so they get an initial mirror. */
  toMirror: RepositoryRow[];
  /** Already on the destination, so they get a refresh. */
  toSync: RepositoryRow[];
  /** In flight, ignored, being deleted or otherwise not ours to touch. */
  skipped: RepositoryRow[];
}

export interface OrganizationSyncResult {
  /** New repository rows the re-discovery pass imported. */
  discovered: number;
  /** Repositories mirrored for the first time by this run. */
  mirrored: number;
  /** Repositories refreshed on the destination by this run. */
  synced: number;
  /** Repositories another run had already claimed when the sync reached them. */
  skippedInFlight: number;
  /** Repositories that failed after their retries. */
  failed: number;
}

/**
 * Split an organization's repository rows into what a manual sync mirrors,
 * refreshes and leaves alone.
 *
 * Forks are held back from the mirror set when the organization skips forks,
 * the same rule mirrorGitHubOrgToGitea applies, so a run never creates a
 * mirror the organization opted out of. A fork that was mirrored before the
 * opt-out is still refreshed, so an existing mirror does not silently go
 * stale.
 */
export function partitionOrganizationRepositories(
  rows: RepositoryRow[],
  { skipForks }: { skipForks: boolean }
): OrganizationSyncPlan {
  const plan: OrganizationSyncPlan = { toMirror: [], toSync: [], skipped: [] };

  for (const row of rows) {
    const status = row.status as (typeof ORG_SYNC_MIRROR_STATUSES)[number] | string;

    if ((ORG_SYNC_MIRROR_STATUSES as readonly string[]).includes(status)) {
      if (skipForks && row.isForked) {
        plan.skipped.push(row);
      } else {
        plan.toMirror.push(row);
      }
      continue;
    }

    if ((ORG_SYNC_SYNC_STATUSES as readonly string[]).includes(status)) {
      plan.toSync.push(row);
      continue;
    }

    plan.skipped.push(row);
  }

  return plan;
}

/**
 * The organization's repository rows. An organization pinned to one source
 * only covers that source's repositories of the name, the same rule
 * mirrorGitHubOrgToGitea applies; unpinned organizations follow every
 * connected source.
 */
export async function selectOrganizationRepositoryRows({
  userId,
  organization,
  sources,
}: {
  userId: string;
  organization: SyncableOrganization;
  sources: SourceRecord[];
}): Promise<RepositoryRow[]> {
  const pinnedSource = findSourceForOrganization(organization, sources);

  const conditions = [
    eq(repositories.userId, userId),
    eq(repositories.organization, organization.name),
  ];
  if (pinnedSource) {
    conditions.push(eq(repositories.sourceId, pinnedSource.id));
  }

  return db
    .select()
    .from(repositories)
    .where(and(...conditions));
}

/** The row as the mirror and sync entry points expect it. */
function toRepository(row: RepositoryRow): Repository {
  return {
    ...row,
    status: repoStatusEnum.parse(row.status),
    visibility: repositoryVisibilityEnum.parse(row.visibility),
    organization: row.organization ?? undefined,
    lastMirrored: row.lastMirrored ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    forkedFrom: row.forkedFrom ?? undefined,
    mirroredLocation: row.mirroredLocation || "",
  } as Repository;
}

/**
 * A sync that found another run already owning the row returns a skip marker
 * instead of throwing, so the counts can tell it apart from real work.
 */
function wasSkippedAsInFlight(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { skipped?: unknown }).skipped === true
  );
}

/**
 * Only GitHub sources need an API client while mirroring (metadata); other
 * hosts get code-only mirrors through the destination. One organization can
 * hold repositories from several hosts, so each row is handed a client built
 * from its own source.
 */
function createRepositoryOctokitResolver(
  userId: string,
  sources: SourceRecord[]
): (repository: Repository) => Octokit | null {
  return (repository) => {
    const source = findSourceForRepository(repository, sources);
    if (!source || source.provider !== "github") return null;

    const token = decryptSourceToken(source.token);
    // A tokenless GitHub source still gets an anonymous public client
    // (60 req/hr) so public-repo metadata mirrors; an empty token must never
    // reach createGitHubClient, which would send `auth: ""`.
    return token
      ? createGitHubClient(
          token,
          userId,
          source.username || undefined,
          resolveGitHubApiBaseUrl(source.url)
        )
      : createPublicGitHubClient(resolveGitHubApiBaseUrl(source.url));
  };
}

/**
 * Mirror one never-mirrored repository, the per-repository path retry-repo
 * uses: a push destination creates the target itself, a pull destination
 * needs the owning organization, which the org mirror entry point creates on
 * demand.
 */
async function mirrorOneRepository({
  config,
  repository,
  octokit,
  sourceUsername,
}: {
  config: Partial<Config>;
  repository: Repository;
  octokit: Octokit | null;
  sourceUsername?: string;
}): Promise<void> {
  if (usesPushEngine(config)) {
    await mirrorRepositoryToDestination({ config, octokit, repository });
    return;
  }

  const { getGiteaRepoOwnerAsync } = await import("@/lib/gitea");
  const owner = await getGiteaRepoOwnerAsync({ config, repository, sourceUsername });

  const mirrorStrategy =
    config.githubConfig?.mirrorStrategy ||
    (config.giteaConfig?.preserveOrgStructure ? "preserve" : "flat-user");
  const shouldUseOrgMirror =
    owner !== config.giteaConfig?.defaultOwner || mirrorStrategy === "single-org";

  await mirrorRepositoryToDestination({
    config,
    octokit,
    repository,
    orgName: shouldUseOrgMirror ? owner : undefined,
  });
}

/**
 * Run a manual sync for one organization: re-discover, mirror what was never
 * mirrored, refresh what was. The organization sits at "mirroring" for the
 * duration and settles on "mirrored" or "failed".
 */
export async function runOrganizationSync({
  config,
  userId,
  organization,
}: {
  config: Partial<Config> & { id: string };
  userId: string;
  organization: SyncableOrganization;
}): Promise<OrganizationSyncResult> {
  const startedAt = new Date();

  await db
    .update(organizations)
    .set({ status: repoStatusEnum.parse("mirroring"), updatedAt: startedAt })
    .where(eq(organizations.id, organization.id));

  await createMirrorJob({
    userId,
    organizationId: organization.id,
    organizationName: organization.name,
    message: `Started sync for organization: ${organization.name}`,
    details: `Organization ${organization.name} is being re-discovered, mirrored and synced.`,
    status: repoStatusEnum.parse("mirroring"),
    jobType: "sync",
  });

  const result: OrganizationSyncResult = {
    discovered: 0,
    mirrored: 0,
    synced: 0,
    skippedInFlight: 0,
    failed: 0,
  };
  const notes: string[] = [];

  try {
    // 1. New upstream repositories. A source that cannot be listed must not
    // stop the refresh of everything already mirrored, so the failure is
    // reported in the job details instead of ending the run.
    try {
      const discovery = await rediscoverRepositoriesForOrganization({
        config,
        userId,
        organization,
        phase: "manual organization sync",
        logPrefix: LOG_PREFIX,
      });
      result.discovered = discovery.imported;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `${LOG_PREFIX} Failed to re-discover repositories for organization ${organization.name}: ${message}`
      );
      notes.push(`Re-discovery failed: ${message}`);
    }

    // 2. Plan over the rows as they stand now, the newly imported included.
    const sources = await listSources(userId);
    const rows = await selectOrganizationRepositoryRows({ userId, organization, sources });
    const skipForks = resolveOrganizationSkipForks({
      orgOverrides: organization.mirrorOverrides,
      config,
    });
    const { toMirror, toSync, skipped } = partitionOrganizationRepositories(rows, { skipForks });

    console.log(
      `${LOG_PREFIX} Organization ${organization.name}: mirroring ${toMirror.length}, syncing ${toSync.length}, skipping ${skipped.length} repositories`
    );

    const resolveRepositoryOctokit = createRepositoryOctokitResolver(userId, sources);

    // 3. Initial mirrors.
    if (toMirror.length > 0) {
      const mirrored = await processWithResilience(
        toMirror,
        async (row) => {
          const repository = toRepository(row);
          const source = findSourceForRepository(repository, sources);
          console.log(`${LOG_PREFIX} Starting mirror for repository: ${row.name}`);
          await mirrorOneRepository({
            config,
            repository,
            octokit: resolveRepositoryOctokit(repository),
            sourceUsername: source?.username,
          });
          return row;
        },
        {
          userId,
          jobType: "mirror",
          getItemId: (row) => row.id,
          getItemName: (row) => row.name,
          concurrencyLimit: MIRROR_CONCURRENCY_LIMIT,
          maxRetries: 2,
          retryDelay: 2000,
          checkpointInterval: 1,
          onProgress: (completed, total) => {
            const percentComplete = Math.round((completed / total) * 100);
            console.log(
              `${LOG_PREFIX} Mirror progress for ${organization.name}: ${percentComplete}% (${completed}/${total})`
            );
          },
          onRetry: (row, error, attempt) => {
            console.log(
              `${LOG_PREFIX} Retrying mirror for repository ${row.name} (attempt ${attempt}): ${error.message}`
            );
          },
        }
      );

      result.mirrored = mirrored.length;
      result.failed += toMirror.length - mirrored.length;
    }

    // 4. Refresh of the existing mirrors.
    if (toSync.length > 0) {
      const synced = await processWithResilience(
        toSync,
        async (row) => {
          const repository = toRepository(row);
          console.log(`${LOG_PREFIX} Starting sync for repository: ${row.name}`);
          const syncResult = await syncRepositoryOnDestination({ config, repository });
          return { row, skipped: wasSkippedAsInFlight(syncResult) };
        },
        {
          userId,
          jobType: "sync",
          getItemId: (row) => row.id,
          getItemName: (row) => row.name,
          concurrencyLimit: SYNC_CONCURRENCY_LIMIT,
          maxRetries: 2,
          retryDelay: 2000,
          checkpointInterval: 1,
          onProgress: (completed, total) => {
            const percentComplete = Math.round((completed / total) * 100);
            console.log(
              `${LOG_PREFIX} Sync progress for ${organization.name}: ${percentComplete}% (${completed}/${total})`
            );
          },
          onRetry: (row, error, attempt) => {
            console.log(
              `${LOG_PREFIX} Retrying sync for repository ${row.name} (attempt ${attempt}): ${error.message}`
            );
          },
        }
      );

      result.skippedInFlight = synced.filter((entry) => entry.skipped).length;
      result.synced = synced.length - result.skippedInFlight;
      result.failed += toSync.length - synced.length;
    }

    const summary =
      `${result.mirrored} mirrored, ${result.synced} synced, ${result.discovered} newly discovered, ` +
      `${result.skippedInFlight} already in progress, ${result.failed} failed.`;
    const details = [`Organization ${organization.name}: ${summary}`, ...notes].join(" ");

    if (result.failed > 0) {
      await db
        .update(organizations)
        .set({
          status: repoStatusEnum.parse("failed"),
          updatedAt: new Date(),
          errorMessage: `${result.failed} ${result.failed === 1 ? "repository" : "repositories"} failed to sync.`,
        })
        .where(eq(organizations.id, organization.id));

      await createMirrorJob({
        userId,
        organizationId: organization.id,
        organizationName: organization.name,
        message: `Failed to sync organization: ${organization.name}`,
        details,
        status: repoStatusEnum.parse("failed"),
        jobType: "sync",
      });

      return result;
    }

    await db
      .update(organizations)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
      })
      .where(eq(organizations.id, organization.id));

    await createMirrorJob({
      userId,
      organizationId: organization.id,
      organizationName: organization.name,
      message: `Successfully synced organization: ${organization.name}`,
      details,
      status: repoStatusEnum.parse("mirrored"),
      jobType: "sync",
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(
      `${LOG_PREFIX} Error while syncing organization ${organization.name}: ${message}`
    );

    await db
      .update(organizations)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: message,
      })
      .where(eq(organizations.id, organization.id));

    await createMirrorJob({
      userId,
      organizationId: organization.id,
      organizationName: organization.name,
      message: `Failed to sync organization: ${organization.name}`,
      details: `Organization ${organization.name} failed to sync. Error: ${message}`,
      status: repoStatusEnum.parse("failed"),
      jobType: "sync",
    });

    return result;
  }
}
