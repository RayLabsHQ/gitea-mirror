/**
 * Repository cleanup service for handling orphaned repositories
 * This service identifies and handles repositories that exist in Gitea
 * but are no longer present in GitHub (e.g., unstarred repositories)
 */

import { db, configs, repositories } from '@/lib/db';
import { eq, and, or, sql, not, inArray } from 'drizzle-orm';
import { createGitHubClient, getGithubRepositories, getGithubStarredRepositories } from '@/lib/github';
import { createGiteaClient, deleteGiteaRepo, archiveGiteaRepo, getGiteaRepoOwnerAsync, checkRepoLocation } from '@/lib/gitea';
import { getDecryptedGitHubToken, getDecryptedGiteaToken } from '@/lib/utils/config-encryption';
import { publishEvent } from '@/lib/events';
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
 * Identify orphaned repositories for a user
 * These are repositories that exist in our database (and likely in Gitea)
 * but are no longer in GitHub based on current criteria
 */
async function identifyOrphanedRepositories(config: any): Promise<any[]> {
  const userId = config.userId;
  
  try {
    // Get current GitHub repositories with rate limit tracking
    const decryptedToken = getDecryptedGitHubToken(config);
    const githubUsername = config.githubConfig?.owner || undefined;
    const octokit = createGitHubClient(decryptedToken, userId, githubUsername);
    
    let allGithubRepos = [];
    let githubApiAccessible = true;
    
    try {
      // Fetch GitHub data. Always include collaborator repos and bypass the
      // organization allowlist here regardless of the user's import filters,
      // otherwise repos previously mirrored as a collaborator or from an org the
      // user later removed from the allowlist would be flagged as orphaned and
      // archived/deleted as soon as the user narrows those filters.
      const [basicAndForkedRepos, starredRepos] = await Promise.all([
        getGithubRepositories({
          octokit,
          config,
          includeCollaboratorReposOverride: true,
          includeAllOrgsOverride: true,
        }),
        config.githubConfig?.includeStarred
          ? getGithubStarredRepositories({ octokit, config })
          : Promise.resolve([]),
      ]);
      
      allGithubRepos = [...basicAndForkedRepos, ...starredRepos];
    } catch (githubError: any) {
      // Handle GitHub API errors gracefully
      console.warn(`[Repository Cleanup] GitHub API error for user ${userId}: ${githubError.message}`);
      
      // Check if it's a critical error (like account deleted/banned)
      if (githubError.status === 404 || githubError.status === 403) {
        console.error(`[Repository Cleanup] CRITICAL: GitHub account may be deleted/banned. Skipping cleanup to prevent data loss.`);
        console.error(`[Repository Cleanup] Consider using CLEANUP_ORPHANED_REPO_ACTION=archive instead of delete for safety.`);
        
        // Return empty array to skip cleanup entirely when GitHub account is inaccessible
        return [];
      }
      
      // For other errors, also skip cleanup to be safe
      console.error(`[Repository Cleanup] Skipping cleanup due to GitHub API error. This prevents accidental deletion of backups.`);
      return [];
    }
    
    const githubReposByFullName = new Map(
      allGithubRepos.map((repo) => [repo.fullName, repo] as const)
    );
    
    // Get all repositories from our database
    const dbRepos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.userId, userId));
    
    // Only identify repositories as orphaned if we successfully accessed GitHub
    // This prevents false positives when GitHub is down or account is inaccessible.
    //
    // First pass (sync, cheap): filter down to repos that merely *look*
    // orphaned based on map membership against the single bulk fetch above.
    // This is the false-positive-prone signal — see resolveOrphanVerdict.
    const candidateOrphans = dbRepos.filter(repo => {
      // Skip repositories we've already archived/preserved
      if (repo.status === 'archived' || repo.isArchived) {
        console.log(`[Repository Cleanup] Skipping ${repo.fullName} - already archived`);
        return false;
      }

      // If starred repos are not being fetched from GitHub, we can't determine
      // if a starred repo is orphaned - skip it to prevent data loss
      if (repo.isStarred && !config.githubConfig?.includeStarred) {
        console.log(`[Repository Cleanup] Skipping starred repo ${repo.fullName} - starred repos not being fetched from GitHub`);
        return false;
      }

      const githubRepo = githubReposByFullName.get(repo.fullName);
      if (!githubRepo) {
        // Missing from the bulk list — candidate for direct confirmation below,
        // not yet a confirmed orphan.
        return true;
      }

      if (!isMirrorableGitHubRepo(githubRepo)) {
        console.log(`[Repository Cleanup] Preserving ${repo.fullName} - repository is disabled on GitHub`);
        return false;
      }

      return false;
    });

    if (candidateOrphans.length === 0) {
      return [];
    }

    // Second pass (async, targeted): confirm each candidate directly against
    // GitHub before finalizing it as orphaned. This only adds extra API calls
    // for the (presumably small) set of repos that look orphaned, not for
    // every repo, so it shouldn't meaningfully increase rate-limit pressure
    // in the common case (few or no orphans per run). Promise.allSettled so
    // one repo's verification failure can't block the others.
    const verificationOutcomes = await Promise.allSettled(
      candidateOrphans.map(async (repo) => {
        if (repo.isStarred) {
          try {
            await octokit.rest.activity.checkRepoIsStarredByAuthenticatedUser({
              owner: repo.owner,
              repo: repo.name,
            });
            // Resolves (no throw) => still starred; the bulk star fetch
            // missed it. Fail safe: do not treat as orphaned.
            return { repo, directCheckConfirmsGone: false };
          } catch (starError: any) {
            if (starError?.status === 404) {
              return { repo, directCheckConfirmsGone: true };
            }
            console.warn(
              `[Repository Cleanup] Direct star-check for ${repo.fullName} failed with a non-404 error; skipping this cycle to be safe: ${
                starError instanceof Error ? starError.message : String(starError)
              }`
            );
            return { repo, directCheckConfirmsGone: false };
          }
        }

        try {
          await octokit.rest.repos.get({ owner: repo.owner, repo: repo.name });
          // Resolves (no throw) => repo still exists; the bulk fetch missed
          // it (e.g. an org-allowlist edge case). Fail safe: not orphaned.
          return { repo, directCheckConfirmsGone: false };
        } catch (repoError: any) {
          if (repoError?.status === 404) {
            return { repo, directCheckConfirmsGone: true };
          }
          console.warn(
            `[Repository Cleanup] Direct existence check for ${repo.fullName} failed with a non-404 error; skipping this cycle to be safe: ${
              repoError instanceof Error ? repoError.message : String(repoError)
            }`
          );
          return { repo, directCheckConfirmsGone: false };
        }
      })
    );

    const orphanedRepos = verificationOutcomes
      .map((outcome, index) => {
        if (outcome.status !== 'fulfilled') {
          const repo = candidateOrphans[index];
          console.warn(
            `[Repository Cleanup] Direct orphan verification threw unexpectedly for ${repo.fullName}; skipping this cycle to be safe: ${
              outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
            }`
          );
          return null;
        }

        const { repo, directCheckConfirmsGone } = outcome.value;
        const isOrphaned = resolveOrphanVerdict({
          fullNameFoundInBulkList: false,
          directCheckConfirmsGone,
        });

        if (!isOrphaned) {
          return null;
        }

        console.log(
          `[Repository Cleanup] Confirmed orphaned via direct GitHub check: ${repo.fullName}`
        );
        return repo;
      })
      .filter((repo): repo is (typeof dbRepos)[number] => repo !== null);

    if (orphanedRepos.length > 0) {
      console.log(`[Repository Cleanup] Found ${orphanedRepos.length} orphaned repositories for user ${userId}`);
    }

    return orphanedRepos;
  } catch (error) {
    console.error(`[Repository Cleanup] Error identifying orphaned repositories for user ${userId}:`, error);
    // Return empty array on error to prevent accidental deletions
    return [];
  }
}

/**
 * Handle an orphaned repository based on configuration
 */
async function handleOrphanedRepository(
  config: any,
  repo: any,
  action: 'skip' | 'archive' | 'delete',
  dryRun: boolean
): Promise<void> {
  const repoFullName = repo.fullName;
  
  if (action === 'skip') {
    console.log(`[Repository Cleanup] Skipping orphaned repository ${repoFullName}`);
    return;
  }

  if (repo.status === 'archived' || repo.isArchived) {
    console.log(`[Repository Cleanup] Repository ${repoFullName} already archived; skipping additional actions`);
    return;
  }

  if (dryRun) {
    console.log(`[Repository Cleanup] DRY RUN: Would ${action} orphaned repository ${repoFullName}`);
    return;
  }
  
  try {
    // Get Gitea client
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
    
    if (action === 'archive') {
      console.log(`[Repository Cleanup] Archiving orphaned repository ${repoFullName} in Gitea`);
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

      // Update database status. If the archive call renamed the repo in Gitea
      // (mirror path), persist the new location so a subsequent "Manual Sync"
      // (the UI's documented path for refreshing an archived mirror) can find
      // it by its actual current name instead of the stale pre-rename one —
      // otherwise syncGiteaRepoEnhanced looks up a name that no longer exists
      // and Gitea returns HTTP 405 ("not a pull mirror").
      //
      // Only mirroredLocation gets the Gitea-side `archived-{name}` value.
      // Do NOT write it into `name`: repositories.name is consumed as the
      // GITHUB repo name elsewhere (release listing, force-push detection),
      // and mirroredLocation alone is what syncGiteaRepoEnhanced resolves
      // first when locating the Gitea mirror.
      const dbUpdate: Record<string, any> = {
        status: 'archived',
        isArchived: true,
        errorMessage: 'Repository archived - no longer in GitHub',
        updatedAt: new Date(),
      };
      if (archivedName && archivedName !== giteaRepoName) {
        dbUpdate.mirroredLocation = `${giteaOwner}/${archivedName}`;
      }
      await db.update(repositories).set(dbUpdate).where(eq(repositories.id, repo.id));
      
      // Create event
      await publishEvent({
        userId: config.userId,
        channel: 'repository',
        payload: {
          type: 'repository.archived',
          message: `Repository ${repoFullName} archived (no longer in GitHub)`,
          metadata: {
            repositoryId: repo.id,
            repositoryName: repo.name,
            action: 'archive',
            reason: 'orphaned',
          },
        },
      });
    } else if (action === 'delete') {
      console.log(`[Repository Cleanup] Deleting orphaned repository ${repoFullName} from Gitea`);
      await deleteGiteaRepo(giteaClient, giteaOwner, giteaRepoName);
      
      // Delete from database
      await db.delete(repositories).where(eq(repositories.id, repo.id));
      
      // Create event
      await publishEvent({
        userId: config.userId,
        channel: 'repository',
        payload: {
          type: 'repository.deleted',
          message: `Repository ${repoFullName} deleted (no longer in GitHub)`,
          metadata: {
            repositoryId: repo.id,
            repositoryName: repo.name,
            action: 'delete',
            reason: 'orphaned',
          },
        },
      });
    }
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
async function runRepositoryCleanup(config: any): Promise<{
  orphanedCount: number;
  processedCount: number;
  errors: string[];
}> {
  const userId = config.userId;
  const cleanupConfig = config.cleanupConfig || {};
  
  console.log(`[Repository Cleanup] Starting repository cleanup for user ${userId}`);
  
  const results = {
    orphanedCount: 0,
    processedCount: 0,
    errors: [] as string[],
  };
  
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
    
    // Warn if deleteFromGitea is explicitly disabled but deleteIfNotInGitHub is enabled
    if (cleanupConfig.deleteFromGitea === false && cleanupConfig.deleteIfNotInGitHub) {
      console.warn(`[Repository Cleanup] Warning: CLEANUP_DELETE_FROM_GITEA is false but CLEANUP_DELETE_IF_NOT_IN_GITHUB is true. Proceeding with cleanup.`);
    }
    
    // Identify orphaned repositories
    const orphanedRepos = await identifyOrphanedRepositories(config);
    results.orphanedCount = orphanedRepos.length;
    
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
    
    for (let i = 0; i < orphanedRepos.length; i += batchSize) {
      const batch = orphanedRepos.slice(i, i + batchSize);
      
      for (const repo of batch) {
        // Skip protected repositories
        if (protectedRepos.has(repo.name) || protectedRepos.has(repo.fullName)) {
          console.log(`[Repository Cleanup] Skipping protected repository ${repo.fullName}`);
          continue;
        }
        
        try {
          await handleOrphanedRepository(config, repo, action, dryRun);
          results.processedCount++;
        } catch (error) {
          const errorMsg = `Failed to ${action} ${repo.fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          console.error(`[Repository Cleanup] ${errorMsg}`);
          results.errors.push(errorMsg);
        }
        
        // Pause between operations to avoid rate limiting
        if (i < orphanedRepos.length - 1) {
          await new Promise(resolve => setTimeout(resolve, pauseBetweenDeletes));
        }
      }
    }
    
    // Update cleanup timestamps
    const currentTime = new Date();
    await db.update(configs).set({
      cleanupConfig: {
        ...cleanupConfig,
        lastRun: currentTime,
        nextRun: new Date(currentTime.getTime() + 24 * 60 * 60 * 1000), // Next run in 24 hours
      },
      updatedAt: currentTime,
    }).where(eq(configs.id, config.id));
    
    console.log(`[Repository Cleanup] Completed cleanup for user ${userId}: ${results.processedCount}/${results.orphanedCount} processed`);
  } catch (error) {
    console.error(`[Repository Cleanup] Error during cleanup for user ${userId}:`, error);
    results.errors.push(`General cleanup error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  return results;
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
 * Manually trigger repository cleanup for a specific user
 */
export async function triggerRepositoryCleanup(userId: string): Promise<{
  orphanedCount: number;
  processedCount: number;
  errors: string[];
}> {
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
  
  return runRepositoryCleanup(config);
}
