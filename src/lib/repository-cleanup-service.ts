/**
 * Repository cleanup service for handling orphaned repositories
 * This service identifies and handles repositories that exist in Gitea
 * but are no longer present in GitHub (e.g., unstarred repositories)
 */

import { db, configs, repositories } from '@/lib/db';
import { eq, and, or, sql, not, inArray } from 'drizzle-orm';
import { createGitHubClient, getGithubRepositories, getGithubStarredRepositories } from '@/lib/github';
import { createGiteaClient, deleteGiteaRepo, archiveGiteaRepo } from '@/lib/gitea';
import { getDecryptedGitHubToken, getDecryptedGiteaToken } from '@/lib/utils/config-encryption';
import { publishEvent } from '@/lib/events';

let cleanupInterval: NodeJS.Timeout | null = null;
let isCleanupRunning = false;

/**
 * Identify orphaned repositories for a user
 * These are repositories that exist in our database (and likely in Gitea)
 * but are no longer in GitHub based on current criteria
 */
async function identifyOrphanedRepositories(config: any): Promise<any[]> {
  const userId = config.userId;
  
  try {
    // Get current GitHub repositories
    const decryptedToken = getDecryptedGitHubToken(config);
    const octokit = createGitHubClient(decryptedToken);
    
    // Fetch GitHub data
    const [basicAndForkedRepos, starredRepos] = await Promise.all([
      getGithubRepositories({ octokit, config }),
      config.githubConfig?.includeStarred
        ? getGithubStarredRepositories({ octokit, config })
        : Promise.resolve([]),
    ]);
    
    const allGithubRepos = [...basicAndForkedRepos, ...starredRepos];
    const githubRepoFullNames = new Set(allGithubRepos.map(repo => repo.fullName));
    
    // Get all repositories from our database
    const dbRepos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.userId, userId));
    
    // Identify orphaned repositories
    const orphanedRepos = dbRepos.filter(repo => !githubRepoFullNames.has(repo.fullName));
    
    return orphanedRepos;
  } catch (error) {
    console.error(`[Repository Cleanup] Error identifying orphaned repositories for user ${userId}:`, error);
    throw error;
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
  
  if (dryRun) {
    console.log(`[Repository Cleanup] DRY RUN: Would ${action} orphaned repository ${repoFullName}`);
    return;
  }
  
  try {
    // Get Gitea client
    const giteaToken = getDecryptedGiteaToken(config);
    const giteaClient = createGiteaClient(config.giteaConfig.url, giteaToken);
    
    // Determine the Gitea owner and repo name
    const mirroredLocation = repo.mirroredLocation || '';
    let giteaOwner = repo.owner;
    let giteaRepoName = repo.name;
    
    if (mirroredLocation) {
      const parts = mirroredLocation.split('/');
      if (parts.length >= 2) {
        giteaOwner = parts[parts.length - 2];
        giteaRepoName = parts[parts.length - 1];
      }
    }
    
    if (action === 'archive') {
      console.log(`[Repository Cleanup] Archiving orphaned repository ${repoFullName} in Gitea`);
      await archiveGiteaRepo(giteaClient, giteaOwner, giteaRepoName);
      
      // Update database status
      await db.update(repositories).set({
        status: 'archived',
        errorMessage: 'Repository archived - no longer in GitHub',
        updatedAt: new Date(),
      }).where(eq(repositories.id, repo.id));
      
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
    const dryRun = cleanupConfig.dryRun ?? true;
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