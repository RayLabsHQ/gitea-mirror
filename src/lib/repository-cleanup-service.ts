/**
 * Repository cleanup service for handling orphaned repositories
 * This service identifies and handles repositories that exist in Gitea
 * but are no longer present in GitHub (e.g., unstarred repositories)
 */

import { db, configs, repositories } from '@/lib/db';
import { eq, and, or, sql, not, inArray } from 'drizzle-orm';
import {
  describeSource,
  getRepositorySource,
  isRepositoryFromConfiguredSource,
  sourceKindListsRepositories,
} from '@/lib/source-providers';
import { createGiteaClient, deleteGiteaRepo, archiveGiteaRepo, getGiteaRepoOwnerAsync, checkRepoLocation } from '@/lib/gitea';
import { usesPushEngine } from '@/lib/destination-connection';
import { getDecryptedGiteaToken } from '@/lib/utils/config-encryption';
import { publishEvent } from '@/lib/events';
import { triggerRepositoryCleanupNotification, triggerSourceMissingNotification } from '@/lib/notification-service';
import { isMirrorableGitHubRepo } from '@/lib/repo-eligibility';

let cleanupInterval: NodeJS.Timeout | null = null;
let isCleanupRunning = false;

/**
 * Decide whether a DB repository that appears to be missing from the bulk
 * GitHub fetch should actually be treated as orphaned.
 *
 * The bulk fetch (owned+collaborator+org repos, plus starred repos) that
 * feeds `fullNameFoundInBulkList` can be transiently incomplete — rate-limit
 * timing, GraphQL star-list pagination quirks, org-allowlist edge cases,
 * etc. — so a repo missing from it is only a *candidate*, not a confirmed
 * orphan. It is only orphaned when a direct, targeted GitHub call ALSO
 * confirms the repo is gone (a clean 404). Any other outcome — the repo
 * still exists, or the direct check itself failed for some other reason
 * (network error, rate limit, 5xx, timeout) — must NOT be treated as
 * orphaned; this fails safe and matches the existing fail-safe philosophy
 * already in this module for GitHub API errors.
 *
 * Pure/exported so the decision logic is unit-testable without hitting the
 * DB or octokit (see repository-cleanup-service.test.ts).
 */
export function resolveOrphanVerdict({
  fullNameFoundInBulkList,
  directCheckConfirmsGone,
}: {
  fullNameFoundInBulkList: boolean;
  directCheckConfirmsGone: boolean;
}): boolean {
  if (fullNameFoundInBulkList) {
    return false;
  }
  return directCheckConfirmsGone;
}

/**
 * Decide what an orphaned-repo cleanup action actually does, split into the
 * Gitea-side operation and the local-database operation.
 *
 * `deleteFromGitea` (CLEANUP_DELETE_FROM_GITEA) gates the Gitea side: it has
 * always been documented as "Delete repositories from Gitea" with a `false`
 * default, but until #366 the code never read it and archived/deleted on
 * Gitea unconditionally. With it disabled (the default), cleanup only
 * updates gitea-mirror's own records — orphans are marked archived or
 * removed from the local database, and the Gitea/Forgejo copy is left
 * untouched.
 *
 * Pure/exported so the decision logic is unit-testable (see
 * repository-cleanup-service.test.ts).
 */
export function planOrphanedRepoAction(
  action: "skip" | "archive" | "delete",
  deleteFromGitea: boolean
): { gitea: "archive" | "delete" | "none"; db: "archive" | "delete" | "none" } {
  if (action === "skip") {
    return { gitea: "none", db: "none" };
  }
  if (action === "archive") {
    return { gitea: deleteFromGitea ? "archive" : "none", db: "archive" };
  }
  return { gitea: deleteFromGitea ? "delete" : "none", db: "delete" };
}

/**
 * Identify orphaned repositories for a user
 * These are repositories that exist in our database (and likely in Gitea)
 * but are no longer in GitHub based on current criteria
 */
/**
 * Split a stored full name into the owner path and repository name the
 * source host expects. Falls back to the stored owner/name for rows whose
 * full name does not contain a slash.
 */
export function splitFullName(
  fullName: string,
  fallbackOwner: string,
  fallbackName: string
): { owner: string; name: string } {
  const segments = fullName.split('/').filter(Boolean);
  if (segments.length < 2) {
    return { owner: fallbackOwner, name: fallbackName };
  }
  return { owner: segments.slice(0, -1).join('/'), name: segments[segments.length - 1] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The configured wait in whole days (#549); anything unusable means none. */
export function cleanupGraceDays(cleanupConfig: { orphanedRepoGraceDays?: unknown } | null | undefined): number {
  const days = Number(cleanupConfig?.orphanedRepoGraceDays);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
}

/** When a repository whose source went missing at `missingSince` is acted on. */
export function cleanupDueAt(missingSince: Date, graceDays: number): Date {
  return new Date(missingSince.getTime() + graceDays * DAY_MS);
}

/** What one pass over the sources found. */
interface OrphanScan {
  /** Rows whose source is confirmed gone. */
  orphaned: any[];
  /** Rows that carry a source-missing time but whose source was found again. */
  seenAgain: any[];
}

async function identifyOrphanedRepositories(config: any): Promise<any[]> {
  return (await scanForOrphanedRepositories(config)).orphaned;
}

async function scanForOrphanedRepositories(config: any): Promise<OrphanScan> {
  const userId = config.userId;

  try {
    // Multi-source: each enabled source vouches for the repositories that
    // were imported from it. Orphans found by the sources are aggregated
    // (deduped by repository id).
    const { listSources } = await import('@/lib/sources');
    const { createSourceProviderFromSource } = await import('@/lib/source-providers');
    const sources = (await listSources(userId)).filter(source => source.enabled);
    const knownSourceIds = new Set(sources.map(source => source.id));

    const dbRepos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.userId, userId));

    // Legacy rows without a source, and rows whose source was deleted
    // (dangling source id), keep mirroring on the destination side but
    // cleanup leaves them alone (the documented "switched source" behavior).
    const sourceOwnedRepos = dbRepos.filter(repo => {
      if (!repo.sourceId) {
        console.log(`[Repository Cleanup] Skipping ${repo.fullName} - not tied to any source`);
        return false;
      }
      if (!knownSourceIds.has(repo.sourceId)) {
        console.log(`[Repository Cleanup] Skipping ${repo.fullName} - its source no longer exists`);
        return false;
      }
      return true;
    });

    const orphanedById = new Map<string, any>();
    // Only a clean sighting clears the wait (#549); an error proves nothing.
    const seenAgainById = new Map<string, any>();
    const markSeen = (repo: any) => {
      if (repo.sourceMissingSince) seenAgainById.set(repo.id, repo);
    };

    for (const source of sources) {
      // A plain git host has no listing to be missing from, so nothing on it
      // can be told to be orphaned. Its repositories are left alone (#514).
      if (!sourceKindListsRepositories(source.provider)) {
        continue;
      }

      // The source host with its token decrypted (GitHub honors GH_API_URL and tracks rate limits)
      const sourceProvider = createSourceProviderFromSource(source, { userId });
      const sourceConnection = sourceProvider.connection;

      let allGithubRepos: any[] = [];

      try {
        // Fetch source data. Always include collaborator repos and bypass the
        // organization allowlist here regardless of the user's import filters,
        // otherwise repos previously mirrored as a collaborator or from an org the
        // user later removed from the allowlist would be flagged as orphaned and
        // archived/deleted as soon as the user narrows those filters.
        const [basicAndForkedRepos, starredRepos] = await Promise.all([
          sourceProvider.listRepositories(config, {
            includeCollaboratorReposOverride: true,
            includeAllOrgsOverride: true,
          }),
          config.githubConfig?.includeStarred
            ? sourceProvider.listStarredRepositories(config)
            : Promise.resolve([]),
        ]);

        allGithubRepos = [...basicAndForkedRepos, ...starredRepos];
      } catch (githubError: any) {
        // Handle source API errors gracefully
        console.warn(`[Repository Cleanup] Source API error for user ${userId} on source ${source.name}: ${githubError.message}`);

        // Check if it's a critical error (like account deleted/banned)
        if (githubError.status === 404 || githubError.status === 403) {
          console.error(`[Repository Cleanup] CRITICAL: the account on source ${source.name} may be deleted/banned. Skipping cleanup for this source to prevent data loss.`);
          console.error(`[Repository Cleanup] Consider using CLEANUP_ORPHANED_REPO_ACTION=archive instead of delete for safety.`);
        } else {
          // For other errors, also skip this source to be safe
          console.error(`[Repository Cleanup] Skipping cleanup of source ${source.name} due to a source API error. This prevents accidental deletion of backups.`);
        }
        continue;
      }

      const githubReposByFullName = new Map(
        allGithubRepos.map((repo) => [repo.fullName, repo] as const)
      );

      // Only identify repositories as orphaned if we successfully accessed the
      // source. This prevents false positives when the source is down or the
      // account is inaccessible.
      //
      // First pass (sync, cheap): filter down to repos that merely *look*
      // orphaned based on map membership against the single bulk fetch above.
      // This is the false-positive-prone signal — see resolveOrphanVerdict.
      const candidateOrphans = sourceOwnedRepos.filter(repo => {
        // Skip repositories we've already archived/preserved
        if (repo.status === 'archived' || repo.isArchived) {
          console.log(`[Repository Cleanup] Skipping ${repo.fullName} - already archived`);
          return false;
        }

        // Only this source can vouch for its own rows; other sources' rows
        // are handled by their source's iteration.
        if (repo.sourceId !== source.id) {
          return false;
        }

        // The row must still match the source it was imported from (the
        // source host cannot vouch for a repository imported from another
        // provider/instance before it was switched).
        if (!isRepositoryFromConfiguredSource(repo, sourceConnection)) {
          console.log(
            `[Repository Cleanup] Skipping ${repo.fullName} - imported from ${describeSource(getRepositorySource(repo))}, not from source ${source.name}`
          );
          return false;
        }

        // If starred repos are not being fetched from the source, we can't determine
        // if a starred repo is orphaned - skip it to prevent data loss
        if (repo.isStarred && !config.githubConfig?.includeStarred) {
          console.log(`[Repository Cleanup] Skipping starred repo ${repo.fullName} - starred repos not being fetched from the source`);
          return false;
        }

        const githubRepo = githubReposByFullName.get(repo.fullName);
        if (!githubRepo) {
          // Missing from the bulk list — candidate for direct confirmation below,
          // not yet a confirmed orphan.
          return true;
        }
        markSeen(repo);

        if (!isMirrorableGitHubRepo(githubRepo)) {
          console.log(`[Repository Cleanup] Preserving ${repo.fullName} - repository is disabled on the source`);
          return false;
        }

        return false;
      });

      if (candidateOrphans.length === 0) {
        continue;
      }

      // Second pass (async, targeted): confirm each candidate directly against
      // the source before finalizing it as orphaned. This only adds extra API
      // calls for the (presumably small) set of repos that look orphaned, not
      // for every repo, so it shouldn't meaningfully increase rate-limit
      // pressure in the common case (few or no orphans per run).
      // Promise.allSettled so one repo's verification failure can't block the
      // others.
      const verificationOutcomes = await Promise.allSettled(
        candidateOrphans.map(async (repo) => {
          // Look the repository up by its full name: a GitLab project under a
          // subgroup is stored with the top level group as owner, so owner/name
          // would not resolve on the source host.
          const upstreamPath = splitFullName(repo.fullName, repo.owner, repo.name);

          if (repo.isStarred) {
            try {
              const stillStarred = await sourceProvider.isRepositoryStarred(
                upstreamPath.owner,
                upstreamPath.name
              );
              // Still starred => the bulk star fetch missed it. Fail safe: do
              // not treat as orphaned. A clean "not starred" confirms it.
              return { repo, directCheckConfirmsGone: !stillStarred, seen: stillStarred };
            } catch (starError: any) {
              console.warn(
                `[Repository Cleanup] Direct star-check for ${repo.fullName} failed with a non-404 error; skipping this cycle to be safe: ${
                  starError instanceof Error ? starError.message : String(starError)
                }`
              );
              return { repo, directCheckConfirmsGone: false, seen: false };
            }
          }

          try {
            const upstream = await sourceProvider.getRepository(
              upstreamPath.owner,
              upstreamPath.name
            );
            // Present => the bulk fetch missed it (e.g. an org-allowlist edge
            // case). Fail safe: not orphaned. A clean 404 (null) confirms it.
            return { repo, directCheckConfirmsGone: upstream === null, seen: upstream !== null };
          } catch (repoError: any) {
            console.warn(
              `[Repository Cleanup] Direct existence check for ${repo.fullName} failed with a non-404 error; skipping this cycle to be safe: ${
                repoError instanceof Error ? repoError.message : String(repoError)
              }`
            );
            return { repo, directCheckConfirmsGone: false, seen: false };
          }
        })
      );

      verificationOutcomes.forEach((outcome, index) => {
        if (outcome.status !== 'fulfilled') {
          const repo = candidateOrphans[index];
          console.warn(
            `[Repository Cleanup] Direct orphan verification threw unexpectedly for ${repo.fullName}; skipping this cycle to be safe: ${
              outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
            }`
          );
          return;
        }

        const { repo, directCheckConfirmsGone, seen } = outcome.value;
        if (seen) markSeen(repo);
        const isOrphaned = resolveOrphanVerdict({
          fullNameFoundInBulkList: false,
          directCheckConfirmsGone,
        });

        if (!isOrphaned) {
          return;
        }

        console.log(
          `[Repository Cleanup] Confirmed orphaned via direct source check: ${repo.fullName}`
        );
        orphanedById.set(repo.id, repo);
      });
    }

    const orphanedRepos = Array.from(orphanedById.values());
    if (orphanedRepos.length > 0) {
      console.log(`[Repository Cleanup] Found ${orphanedRepos.length} orphaned repositories for user ${userId}`);
    }

    return { orphaned: orphanedRepos, seenAgain: Array.from(seenAgainById.values()) };
  } catch (error) {
    console.error(`[Repository Cleanup] Error identifying orphaned repositories for user ${userId}:`, error);
    // Return empty array on error to prevent accidental deletions
    return { orphaned: [], seenAgain: [] };
  }
}

/**
 * Resolve the Gitea client and the owner/name the repo lives under on the
 * Gitea side. Only called when the cleanup plan actually touches Gitea, so
 * a database-only cleanup never needs a decryptable Gitea token.
 */
async function resolveGiteaTarget(config: any, repo: any): Promise<{
  giteaClient: ReturnType<typeof createGiteaClient>;
  giteaOwner: string;
  giteaRepoName: string;
}> {
  const giteaToken = getDecryptedGiteaToken(config);
  const giteaClient = createGiteaClient(config.giteaConfig.url, giteaToken);

  // Determine the Gitea owner and repo name more robustly
  const mirroredLocation = (repo.mirroredLocation || '').trim();
  let giteaOwner: string;
  let giteaRepoName: string;

  if (mirroredLocation && mirroredLocation.includes('/')) {
    const [ownerPart, namePart] = mirroredLocation.split('/');
    giteaOwner = ownerPart;
    giteaRepoName = namePart;
  } else {
    // Fall back to expected owner based on config and repo flags (starred/org overrides)
    giteaOwner = await getGiteaRepoOwnerAsync({ config, repository: repo });
    giteaRepoName = repo.name;
  }

  // Normalize owner casing to avoid GetUserByName issues on some Gitea setups
  giteaOwner = giteaOwner.trim();

  return { giteaClient, giteaOwner, giteaRepoName };
}

/**
 * Handle an orphaned repository based on configuration
 */
/**
 * What handleOrphanedRepository did: "none" for the skip action, a dry run,
 * or a repository an earlier run already archived.
 */
export type OrphanedRepositoryOutcome = 'none' | 'archived' | 'deleted';

async function handleOrphanedRepository(
  config: any,
  repo: any,
  action: 'skip' | 'archive' | 'delete',
  dryRun: boolean
): Promise<OrphanedRepositoryOutcome> {
  const repoFullName = repo.fullName;
  
  if (action === 'skip') {
    console.log(`[Repository Cleanup] Skipping orphaned repository ${repoFullName}`);
    return 'none';
  }

  if (repo.status === 'archived' || repo.isArchived) {
    console.log(`[Repository Cleanup] Repository ${repoFullName} already archived; skipping additional actions`);
    return 'none';
  }

  const plan = planOrphanedRepoAction(action, config.cleanupConfig?.deleteFromGitea === true);

  if (dryRun) {
    console.log(`[Repository Cleanup] DRY RUN: Would ${action} orphaned repository ${repoFullName}${plan.gitea === 'none' ? ' (database only; deleteFromGitea is disabled)' : ' (including the Gitea copy)'}`);
    return 'none';
  }

  try {
    if (action === 'archive') {
      const dbUpdate: Record<string, any> = {
        status: 'archived',
        isArchived: true,
        errorMessage: plan.gitea === 'archive'
          ? 'Repository archived - no longer in GitHub'
          : 'Repository archived in gitea-mirror - no longer in GitHub (Gitea copy untouched)',
        updatedAt: new Date(),
      };

      if (plan.gitea === 'archive' && usesPushEngine(config)) {
        console.log(`[Repository Cleanup] Archiving orphaned repository ${repoFullName} on the push target`);
        const { archiveOnPushTarget } = await import('@/lib/push-engine/cleanup');
        await archiveOnPushTarget({ config, repository: repo });
      } else if (plan.gitea === 'archive') {
        console.log(`[Repository Cleanup] Archiving orphaned repository ${repoFullName} in Gitea`);
        const { giteaClient, giteaRepoName, giteaOwner: expectedOwner } = await resolveGiteaTarget(config, repo);
        let giteaOwner = expectedOwner;
        // Best-effort check to validate actual location; falls back gracefully
        try {
          const { present, actualOwner } = await checkRepoLocation({
            config,
            repository: repo,
            expectedOwner: giteaOwner,
          });
          if (present) {
            giteaOwner = actualOwner;
          }
        } catch {
          // Non-fatal; continue with best guess
        }

        const { archivedName } = await archiveGiteaRepo(giteaClient, giteaOwner, giteaRepoName);

        // If the archive call renamed the repo in Gitea (mirror path), persist
        // the new location so a later manual Sync (the UI's documented
        // path for refreshing an archived mirror) can find it by its actual
        // current name instead of the stale pre-rename one — otherwise
        // syncGiteaRepoEnhanced looks up a name that no longer exists and
        // Gitea returns HTTP 405 ("not a pull mirror").
        //
        // Only mirroredLocation gets the Gitea-side `archived-{name}` value.
        // Do NOT write it into `name`: repositories.name is consumed as the
        // GITHUB repo name elsewhere (release listing, force-push detection),
        // and mirroredLocation alone is what syncGiteaRepoEnhanced resolves
        // first when locating the Gitea mirror.
        if (archivedName && archivedName !== giteaRepoName) {
          dbUpdate.mirroredLocation = `${giteaOwner}/${archivedName}`;
        }
      } else {
        console.log(`[Repository Cleanup] Marking orphaned repository ${repoFullName} archived in gitea-mirror (deleteFromGitea disabled; Gitea copy untouched)`);
      }

      await db.update(repositories).set(dbUpdate).where(eq(repositories.id, repo.id));

      // Create event
      await publishEvent({
        userId: config.userId,
        channel: 'repository',
        payload: {
          type: 'repository.archived',
          message: plan.gitea === 'archive'
            ? `Repository ${repoFullName} archived (no longer in GitHub)`
            : `Repository ${repoFullName} marked archived in gitea-mirror (no longer in GitHub; Gitea copy untouched)`,
          metadata: {
            repositoryId: repo.id,
            repositoryName: repo.name,
            action: 'archive',
            reason: 'orphaned',
          },
        },
      });
      return 'archived';
    } else if (action === 'delete') {
      if (plan.gitea === 'delete' && usesPushEngine(config)) {
        console.log(`[Repository Cleanup] Deleting orphaned repository ${repoFullName} from the push target`);
        const { deleteOnPushTarget } = await import('@/lib/push-engine/cleanup');
        await deleteOnPushTarget({ config, repository: repo });
      } else if (plan.gitea === 'delete') {
        console.log(`[Repository Cleanup] Deleting orphaned repository ${repoFullName} from Gitea`);
        const { giteaClient, giteaOwner, giteaRepoName } = await resolveGiteaTarget(config, repo);
        await deleteGiteaRepo(giteaClient, giteaOwner, giteaRepoName);
      } else {
        console.log(`[Repository Cleanup] Removing orphaned repository ${repoFullName} from gitea-mirror (deleteFromGitea disabled; Gitea copy untouched)`);
      }

      // Delete from database
      await db.delete(repositories).where(eq(repositories.id, repo.id));

      if (usesPushEngine(config)) {
        // The bare clone has no row to belong to any more.
        const { removeCloneForRepository } = await import('@/lib/push-engine/cleanup');
        await removeCloneForRepository({ repository: repo });
      }

      // Create event
      await publishEvent({
        userId: config.userId,
        channel: 'repository',
        payload: {
          type: 'repository.deleted',
          message: plan.gitea === 'delete'
            ? `Repository ${repoFullName} deleted (no longer in GitHub)`
            : `Repository ${repoFullName} removed from gitea-mirror (no longer in GitHub; Gitea copy untouched)`,
          metadata: {
            repositoryId: repo.id,
            repositoryName: repo.name,
            action: 'delete',
            reason: 'orphaned',
          },
        },
      });
      return 'deleted';
    }
    return 'none';
  } catch (error) {
    console.error(`[Repository Cleanup] Error handling orphaned repository ${repoFullName}:`, error);
    
    // Update repository with error status
    await db.update(repositories).set({
      status: 'failed',
      errorMessage: `Cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      updatedAt: new Date(),
    }).where(eq(repositories.id, repo.id));
    
    throw error;
  }
}

/**
 * Run repository cleanup for a single configuration
 */
/** What a repository cleanup run did, for logs and the Run now button. */
export interface RepositoryCleanupResult {
  orphanedCount: number;
  processedCount: number;
  errors: string[];
  /** Full names of the repositories whose source is gone. */
  repositories: string[];
  /** Full names of the repositories this run archived or removed. */
  handled: string[];
  /** Repositories whose source is gone but whose wait is not over (#549). */
  waiting: Array<{ fullName: string; actOn: string }>;
  /** Planned actions were only logged. */
  dryRun: boolean;
  action: "skip" | "archive" | "delete";
}

/** Users with a repository cleanup in progress (#547). */
const usersCleaning = new Set<string>();

/** A Run now click while a run for the same user is still going. */
export class RepositoryCleanupBusyError extends Error {
  constructor() {
    super("Repository cleanup is already running");
    this.name = "RepositoryCleanupBusyError";
  }
}

/**
 * Run repository cleanup for one configuration, at most once at a time per
 * user, so a Run now click cannot overlap the background run. The background
 * loop skips a busy user; Run now reports it.
 */
async function runRepositoryCleanup(
  config: any,
  whenBusy: 'skip' | 'throw' = 'skip'
): Promise<RepositoryCleanupResult> {
  const userId = config.userId;
  if (usersCleaning.has(userId)) {
    if (whenBusy === 'throw') throw new RepositoryCleanupBusyError();
    console.log(`[Repository Cleanup] Cleanup for user ${userId} is already running, skipping`);
    const cleanupConfig = config.cleanupConfig || {};
    return {
      orphanedCount: 0,
      processedCount: 0,
      errors: [],
      repositories: [],
      handled: [],
      waiting: [],
      dryRun: cleanupConfig.dryRun ?? false,
      action: cleanupConfig.orphanedRepoAction || 'archive',
    };
  }
  usersCleaning.add(userId);
  try {
    return await runRepositoryCleanupUnlocked(config);
  } finally {
    usersCleaning.delete(userId);
  }
}

async function runRepositoryCleanupUnlocked(config: any): Promise<RepositoryCleanupResult> {
  const userId = config.userId;
  const cleanupConfig = config.cleanupConfig || {};
  
  console.log(`[Repository Cleanup] Starting repository cleanup for user ${userId}`);
  
  const results: RepositoryCleanupResult = {
    orphanedCount: 0,
    processedCount: 0,
    errors: [] as string[],
    repositories: [],
    handled: [],
    waiting: [],
    dryRun: cleanupConfig.dryRun ?? false,
    action: cleanupConfig.orphanedRepoAction || 'archive',
  };
  const graceDays = cleanupGraceDays(cleanupConfig);
  /** Found gone for the first time in this run and now waiting. */
  const noticed: Array<{ fullName: string; actOn: string }> = [];
  
  try {
    // Check if repository cleanup is enabled - either through the main toggle or the specific feature
    const isCleanupEnabled = cleanupConfig.enabled || cleanupConfig.deleteIfNotInGitHub;
    
    if (!isCleanupEnabled) {
      console.log(`[Repository Cleanup] Repository cleanup disabled for user ${userId} (enabled=${cleanupConfig.enabled}, deleteIfNotInGitHub=${cleanupConfig.deleteIfNotInGitHub})`);
      return results;
    }
    
    // Only process if deleteIfNotInGitHub is enabled (this is the main feature flag)
    if (!cleanupConfig.deleteIfNotInGitHub) {
      console.log(`[Repository Cleanup] Delete if not in GitHub disabled for user ${userId}`);
      return results;
    }
    
    // deleteFromGitea gates whether the orphaned-repo action also touches the
    // Gitea/Forgejo side (see planOrphanedRepoAction).
    if (cleanupConfig.deleteFromGitea !== true) {
      console.log(`[Repository Cleanup] deleteFromGitea is disabled: orphaned repositories will only be updated in gitea-mirror's database; the Gitea copies stay untouched. Set CLEANUP_DELETE_FROM_GITEA=true to also apply the '${cleanupConfig.orphanedRepoAction || 'archive'}' action on Gitea.`);
    }
    
    // Identify orphaned repositories
    const scan = await scanForOrphanedRepositories(config);
    await clearSourceMissing(scan.seenAgain);
    const orphanedRepos = scan.orphaned;
    results.orphanedCount = orphanedRepos.length;
    results.repositories = orphanedRepos.map((repo: any) => repo.fullName);
    
    if (orphanedRepos.length === 0) {
      console.log(`[Repository Cleanup] No orphaned repositories found for user ${userId}`);
      return results;
    }
    
    console.log(`[Repository Cleanup] Found ${orphanedRepos.length} orphaned repositories for user ${userId}`);
    
    // Get protected repositories
    const protectedRepos = new Set(cleanupConfig.protectedRepos || []);
    
    // Process orphaned repositories
    const action = cleanupConfig.orphanedRepoAction || 'archive';
    const dryRun = cleanupConfig.dryRun ?? false;
    const batchSize = cleanupConfig.batchSize || 10;
    const pauseBetweenDeletes = cleanupConfig.pauseBetweenDeletes || 2000;

    // The wait (#549): the first run that finds a source gone records when,
    // and the action waits until the source has been gone for graceDays. The
    // time is recorded in a dry run too, so a dry run shows the real dates.
    // Whole seconds, as stored, so every run reports the same date.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const due: any[] = [];
    for (const repo of orphanedRepos) {
      // Skip protected repositories
      if (protectedRepos.has(repo.name) || protectedRepos.has(repo.fullName)) {
        console.log(`[Repository Cleanup] Skipping protected repository ${repo.fullName}`);
        continue;
      }

      const firstSeen = !repo.sourceMissingSince;
      const missingSince = firstSeen ? now : new Date(repo.sourceMissingSince);
      if (firstSeen) {
        await db
          .update(repositories)
          .set({ sourceMissingSince: now })
          .where(eq(repositories.id, repo.id));
      }

      const actOn = cleanupDueAt(missingSince, graceDays);
      if (actOn.getTime() <= now.getTime()) {
        due.push(repo);
        continue;
      }
      console.log(
        `[Repository Cleanup] The source of ${repo.fullName} is gone since ${missingSince.toISOString()}; waiting until ${actOn.toISOString()} (${graceDays} day wait) before the '${action}' action`
      );
      const entry = { fullName: repo.fullName, actOn: actOn.toISOString() };
      results.waiting.push(entry);
      if (firstSeen) noticed.push(entry);
    }

    // The heads-up goes out only when something will happen at the end of the
    // wait, like the cleanup notification itself.
    if (dryRun || action === 'skip') {
      noticed.length = 0;
    }
    
    for (let i = 0; i < due.length; i += batchSize) {
      const batch = due.slice(i, i + batchSize);
      
      for (const repo of batch) {
        try {
          const outcome = await handleOrphanedRepository(config, repo, action, dryRun);
          results.processedCount++;
          if (outcome !== 'none') {
            results.handled.push(repo.fullName);
          }
        } catch (error) {
          const errorMsg = `Failed to ${action} ${repo.fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          console.error(`[Repository Cleanup] ${errorMsg}`);
          results.errors.push(errorMsg);
        }
        
        // Pause between operations to avoid rate limiting
        if (i < due.length - 1) {
          await new Promise(resolve => setTimeout(resolve, pauseBetweenDeletes));
        }
      }
    }
    
    // No timestamps are written here: cleanupConfig.lastRun and nextRun belong
    // to database maintenance, and writing them moved its next run to 24 hours
    // out whenever an orphan was found (#548).

    console.log(`[Repository Cleanup] Completed cleanup for user ${userId}: ${results.processedCount}/${results.orphanedCount} processed`);
  } catch (error) {
    console.error(`[Repository Cleanup] Error during cleanup for user ${userId}:`, error);
    results.errors.push(`General cleanup error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  const destinationChanged = planOrphanedRepoAction(results.action, cleanupConfig.deleteFromGitea === true).gitea !== 'none';

  // A heads-up for sources found gone in this run that are now waiting
  // (#549), then one notification for what the run did (#554). Never throw.
  await triggerSourceMissingNotification({
    userId,
    action: results.action,
    destinationChanged,
    graceDays,
    repositories: noticed,
  });
  await triggerRepositoryCleanupNotification({
    userId,
    action: results.action,
    destinationChanged,
    repositoryNames: results.handled,
    failures: results.errors,
  });

  return results;
}

/**
 * Forget the source-missing time of rows whose source was found again, so a
 * later disappearance starts a new wait.
 */
async function clearSourceMissing(rows: any[]): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    console.log(`[Repository Cleanup] The source of ${row.fullName} is back; its cleanup wait is reset`);
  }
  await db
    .update(repositories)
    .set({ sourceMissingSince: null })
    .where(inArray(repositories.id, rows.map((row) => row.id)));
}

/**
 * Main repository cleanup loop
 */
async function repositoryCleanupLoop(): Promise<void> {
  if (isCleanupRunning) {
    console.log('[Repository Cleanup] Cleanup is already running, skipping this cycle');
    return;
  }
  
  isCleanupRunning = true;
  
  try {
    // Get all active configurations with repository cleanup enabled
    const activeConfigs = await db
      .select()
      .from(configs)
      .where(eq(configs.isActive, true));
    
    const enabledConfigs = activeConfigs.filter(config => {
      const cleanupConfig = config.cleanupConfig || {};
      // Enable cleanup if either the main toggle is on OR deleteIfNotInGitHub is enabled
      return cleanupConfig.enabled === true || cleanupConfig.deleteIfNotInGitHub === true;
    });
    
    if (enabledConfigs.length === 0) {
      console.log('[Repository Cleanup] No configurations with repository cleanup enabled');
      return;
    }
    
    console.log(`[Repository Cleanup] Processing ${enabledConfigs.length} configurations`);
    
    // Process each configuration
    for (const config of enabledConfigs) {
      await runRepositoryCleanup(config);
    }
  } catch (error) {
    console.error('[Repository Cleanup] Error in cleanup loop:', error);
  } finally {
    isCleanupRunning = false;
  }
}

/**
 * Start the repository cleanup service
 */
export function startRepositoryCleanupService(): void {
  if (cleanupInterval) {
    console.log('[Repository Cleanup] Service is already running');
    return;
  }
  
  console.log('[Repository Cleanup] Starting repository cleanup service');
  
  // Run immediately on start
  repositoryCleanupLoop().catch(error => {
    console.error('[Repository Cleanup] Error during initial cleanup run:', error);
  });
  
  // Run every 6 hours to check for orphaned repositories
  const checkInterval = 6 * 60 * 60 * 1000; // 6 hours
  cleanupInterval = setInterval(() => {
    repositoryCleanupLoop().catch(error => {
      console.error('[Repository Cleanup] Error during cleanup run:', error);
    });
  }, checkInterval);
  
  console.log('[Repository Cleanup] Service started, checking every 6 hours');
}

/**
 * Stop the repository cleanup service
 */
export function stopRepositoryCleanupService(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('[Repository Cleanup] Service stopped');
  }
}

/**
 * Check if the repository cleanup service is running
 */
export function isRepositoryCleanupServiceRunning(): boolean {
  return cleanupInterval !== null;
}

// Export functions for use by scheduler
export { identifyOrphanedRepositories, handleOrphanedRepository };

/**
 * Repository cleanup as part of a scheduled sync: the same run as the
 * background check and Run now (protected repositories, the wait and the
 * notifications included), skipped when one is already going for the user.
 */
export function runRepositoryCleanupForConfig(config: any): Promise<RepositoryCleanupResult> {
  return runRepositoryCleanup(config, 'skip');
}

/**
 * Manually trigger repository cleanup for a specific user
 */
export async function triggerRepositoryCleanup(userId: string): Promise<RepositoryCleanupResult> {
  const [config] = await db
    .select()
    .from(configs)
    .where(and(
      eq(configs.userId, userId),
      eq(configs.isActive, true)
    ))
    .limit(1);
  
  if (!config) {
    throw new Error('No active configuration found for user');
  }
  
  return runRepositoryCleanup(config, 'throw');
}
