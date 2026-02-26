/**
 * Scheduler service for automatic repository mirroring
 * This service runs in the background and automatically mirrors repositories
 * based on the configured schedule
 */

import { db, configs, repositories } from '@/lib/db';
import { eq, and, or } from 'drizzle-orm';
import { syncGiteaRepo, mirrorGithubRepoToGitea } from '@/lib/gitea';
import { getDecryptedGitHubToken } from '@/lib/utils/config-encryption';
import { parseInterval, formatDuration } from '@/lib/utils/duration-parser';
import type { Repository } from '@/lib/db/schema';
import { repoStatusEnum, repositoryVisibilityEnum } from '@/types/Repository';
import { mergeGitReposPreferStarred, normalizeGitRepoToInsert, calcBatchSizeForInsert } from '@/lib/repo-utils';
import { isMirrorableGitHubRepo } from '@/lib/repo-eligibility';

let schedulerInterval: NodeJS.Timeout | null = null;
let isSchedulerRunning = false;
let hasPerformedAutoStart = false; // Track if we've already done auto-start

/**
 * Parse schedule interval with enhanced support for duration strings, cron, and numbers
 * Supports formats like: "8h", "30m", "24h", "0 0/2 * * *", or plain numbers (seconds)
 */
function parseScheduleInterval(interval: string | number): number {
  try {
    const milliseconds = parseInterval(interval);
    console.log(`[Scheduler] Parsed interval "${interval}" as ${formatDuration(milliseconds)}`);
    return milliseconds;
  } catch (error) {
    console.error(`[Scheduler] Failed to parse interval "${interval}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    const defaultInterval = 60 * 60 * 1000; // 1 hour
    console.log(`[Scheduler] Using default interval: ${formatDuration(defaultInterval)}`);
    return defaultInterval;
  }
}

/**
 * Run scheduled mirror sync for a single user configuration
 */
async function runScheduledSync(config: any): Promise<void> {
  const userId = config.userId;
  console.log(`[Scheduler] Running scheduled sync for user ${userId}`);
  
  try {
    // Check if tokens are configured before proceeding
    if (!config.githubConfig?.token || !config.giteaConfig?.token) {
      console.log(`[Scheduler] Skipping sync for user ${userId}: GitHub or Gitea tokens not configured`);
      return;
    }
    
    // Update lastRun timestamp
    const currentTime = new Date();
    const scheduleConfig = config.scheduleConfig || {};
    
    // Priority order: scheduleConfig.interval > giteaConfig.mirrorInterval > default
    const intervalSource = scheduleConfig.interval || 
                          config.giteaConfig?.mirrorInterval || 
                          '1h'; // Default to 1 hour instead of 3600 seconds
    
    console.log(`[Scheduler] Using interval source for user ${userId}: ${intervalSource}`);
    const interval = parseScheduleInterval(intervalSource);
    
    // Note: The interval timing is calculated from the LAST RUN time, not from container startup
    // This means if GITEA_MIRROR_INTERVAL=8h, the next sync will be 8 hours from the last completed sync
    const nextRun = new Date(currentTime.getTime() + interval);
    
    console.log(`[Scheduler] Next sync for user ${userId} scheduled for: ${nextRun.toISOString()} (in ${formatDuration(interval)})`);
    
    await db.update(configs).set({
      scheduleConfig: {
        ...scheduleConfig,
        lastRun: currentTime,
        nextRun: nextRun,
      },
      updatedAt: currentTime,
    }).where(eq(configs.id, config.id));
    
    // Auto-discovery: Check for new GitHub repositories
    if (scheduleConfig.autoImport !== false) {
      console.log(`[Scheduler] Checking for new GitHub repositories for user ${userId}...`);
      try {
        const { getGithubRepositories, getGithubStarredRepositories } = await import('@/lib/github');
        const { v4: uuidv4 } = await import('uuid');
        const { getDecryptedGitHubToken } = await import('@/lib/utils/config-encryption');
        
        // Create GitHub client
        const decryptedToken = getDecryptedGitHubToken(config);
        const { Octokit } = await import('@octokit/rest');
        const octokit = new Octokit({ auth: decryptedToken });
        
        // Fetch GitHub data
        const [basicAndForkedRepos, starredRepos] = await Promise.all([
          getGithubRepositories({ octokit, config }),
          config.githubConfig?.includeStarred
            ? getGithubStarredRepositories({ octokit, config })
            : Promise.resolve([]),
        ]);
        const allGithubRepos = mergeGitReposPreferStarred(basicAndForkedRepos, starredRepos);
        const mirrorableGithubRepos = allGithubRepos.filter(isMirrorableGitHubRepo);
        
        // Check for new repositories
        const existingRepos = await db
          .select({ normalizedFullName: repositories.normalizedFullName })
          .from(repositories)
          .where(eq(repositories.userId, userId));
        
        const existingRepoNames = new Set(existingRepos.map(r => r.normalizedFullName));
        const newRepos = mirrorableGithubRepos.filter(r => !existingRepoNames.has(r.fullName.toLowerCase()));
        
        if (newRepos.length > 0) {
          console.log(`[Scheduler] Found ${newRepos.length} new repositories for user ${userId}`);
          
          // Insert new repositories
          const reposToInsert = newRepos.map(repo => 
            normalizeGitRepoToInsert(repo, { userId, configId: config.id })
          );
          
          // Batch insert to avoid SQLite parameter limit
          const sample = reposToInsert[0];
          const columnCount = Object.keys(sample ?? {}).length || 1;
          const BATCH_SIZE = calcBatchSizeForInsert(columnCount);
          for (let i = 0; i < reposToInsert.length; i += BATCH_SIZE) {
            const batch = reposToInsert.slice(i, i + BATCH_SIZE);
            await db
              .insert(repositories)
              .values(batch)
              .onConflictDoNothing({ target: [repositories.userId, repositories.normalizedFullName] });
          }
          console.log(`[Scheduler] Successfully imported ${newRepos.length} new repositories for user ${userId}`);
        } else {
          console.log(`[Scheduler] No new repositories found for user ${userId}`);
        }
        const skippedDisabledCount = allGithubRepos.length - mirrorableGithubRepos.length;
        if (skippedDisabledCount > 0) {
          console.log(`[Scheduler] Skipped ${skippedDisabledCount} disabled GitHub repositories for user ${userId}`);
        }
      } catch (error) {
        console.error(`[Scheduler] Failed to auto-import repositories for user ${userId}:`, error);
      }
    }
    
    // Auto-cleanup: Remove orphaned repositories (repos that no longer exist in GitHub)
    if (config.cleanupConfig?.deleteIfNotInGitHub) {
      console.log(`[Scheduler] Checking for orphaned repositories to cleanup for user ${userId}...`);
      try {
        const { identifyOrphanedRepositories, handleOrphanedRepository } = await import('@/lib/repository-cleanup-service');
        
        const orphanedRepos = await identifyOrphanedRepositories(config);
        
        if (orphanedRepos.length > 0) {
          console.log(`[Scheduler] Found ${orphanedRepos.length} orphaned repositories for cleanup`);
          
          for (const repo of orphanedRepos) {
            try {
              await handleOrphanedRepository(
                config,
                repo,
                config.cleanupConfig.orphanedRepoAction || 'archive',
                config.cleanupConfig.dryRun ?? false
              );
              console.log(`[Scheduler] Handled orphaned repository: ${repo.fullName}`);
            } catch (error) {
              console.error(`[Scheduler] Failed to handle orphaned repository ${repo.fullName}:`, error);
            }
          }
        } else {
          console.log(`[Scheduler] No orphaned repositories found for cleanup`);
        }
      } catch (error) {
        console.error(`[Scheduler] Failed to cleanup orphaned repositories for user ${userId}:`, error);
      }
    }
    
    // Auto-mirror: Mirror imported/pending/failed repositories if enabled
    if (scheduleConfig.autoMirror) {
      try {
        console.log(`[Scheduler] Auto-mirror enabled - checking for repositories to mirror for user ${userId}...`);
        const reposNeedingMirror = await db
          .select()
          .from(repositories)
          .where(
            and(
              eq(repositories.userId, userId),
              or(
                eq(repositories.status, 'imported'),
                eq(repositories.status, 'pending'),
                eq(repositories.status, 'failed')
              )
            )
          );

        if (reposNeedingMirror.length > 0) {
          console.log(`[Scheduler] Found ${reposNeedingMirror.length} repositories that need initial mirroring`);

          // Prepare Octokit client
          const decryptedToken = getDecryptedGitHubToken(config);
          const { Octokit } = await import('@octokit/rest');
          const octokit = new Octokit({ auth: decryptedToken });

          // Process repositories in batches
          const batchSize = scheduleConfig.batchSize || 10;
          const pauseBetweenBatches = scheduleConfig.pauseBetweenBatches || 2000;
          for (let i = 0; i < reposNeedingMirror.length; i += batchSize) {
            const batch = reposNeedingMirror.slice(i, Math.min(i + batchSize, reposNeedingMirror.length));
            console.log(`[Scheduler] Auto-mirror batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(reposNeedingMirror.length / batchSize)} (${batch.length} repos)`);

            await Promise.all(
              batch.map(async (repo) => {
                try {
                  const repository: Repository = {
                    ...repo,
                    status: repoStatusEnum.parse(repo.status),
                    organization: repo.organization ?? undefined,
                    lastMirrored: repo.lastMirrored ?? undefined,
                    errorMessage: repo.errorMessage ?? undefined,
                    mirroredLocation: repo.mirroredLocation || '',
                    forkedFrom: repo.forkedFrom ?? undefined,
                    visibility: repositoryVisibilityEnum.parse(repo.visibility),
                  };

                  await mirrorGithubRepoToGitea({ octokit, repository, config });
                  console.log(`[Scheduler] Auto-mirrored repository: ${repo.fullName}`);
                } catch (error) {
                  console.error(`[Scheduler] Failed to auto-mirror repository ${repo.fullName}:`, error);
                }
              })
            );

            // Pause between batches if configured
            if (i + batchSize < reposNeedingMirror.length) {
              console.log(`[Scheduler] Pausing for ${pauseBetweenBatches}ms before next auto-mirror batch...`);
              await new Promise(resolve => setTimeout(resolve, pauseBetweenBatches));
            }
          }
        } else {
          console.log(`[Scheduler] No repositories need initial mirroring`);
        }
      } catch (mirrorError) {
        console.error(`[Scheduler] Error during auto-mirror phase for user ${userId}:`, mirrorError);
      }
    }

    // Get repositories to sync
    let reposToSync = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, userId),
          or(
            eq(repositories.status, 'mirrored'),
            eq(repositories.status, 'synced'),
            eq(repositories.status, 'failed'),
            eq(repositories.status, 'pending')
          )
        )
      );
    
    // Filter based on schedule configuration
    if (scheduleConfig.skipRecentlyMirrored) {
      const recentThreshold = scheduleConfig.recentThreshold || 3600000; // Default 1 hour
      const thresholdTime = new Date(currentTime.getTime() - recentThreshold);
      
      reposToSync = reposToSync.filter(repo => {
        if (!repo.lastMirrored) return true; // Never mirrored
        return repo.lastMirrored < thresholdTime;
      });
    }
    
    if (scheduleConfig.onlyMirrorUpdated) {
      const updateInterval = scheduleConfig.updateInterval || 86400000; // Default 24 hours
      const updateThreshold = new Date(currentTime.getTime() - updateInterval);
      
      // Check GitHub for updates (this would need to be implemented)
      // For now, we'll sync repos that haven't been synced in the update interval
      reposToSync = reposToSync.filter(repo => {
        if (!repo.lastMirrored) return true;
        return repo.lastMirrored < updateThreshold;
      });
    }
    
    if (reposToSync.length === 0) {
      console.log(`[Scheduler] No repositories to sync for user ${userId}`);
      return;
    }
    
    console.log(`[Scheduler] Syncing ${reposToSync.length} repositories for user ${userId}`);
    
    // Process repositories in batches
    const batchSize = scheduleConfig.batchSize || 10;
    const pauseBetweenBatches = scheduleConfig.pauseBetweenBatches || 5000;
    const concurrent = scheduleConfig.concurrent ?? false;
    
    for (let i = 0; i < reposToSync.length; i += batchSize) {
      const batch = reposToSync.slice(i, i + batchSize);
      
      if (concurrent) {
        // Process batch concurrently
        await Promise.allSettled(
          batch.map(repo => syncSingleRepository(config, repo))
        );
      } else {
        // Process batch sequentially
        for (const repo of batch) {
          await syncSingleRepository(config, repo);
        }
      }
      
      // Pause between batches if not the last batch
      if (i + batchSize < reposToSync.length) {
        await new Promise(resolve => setTimeout(resolve, pauseBetweenBatches));
      }
    }
    
    console.log(`[Scheduler] Completed scheduled sync for user ${userId}`);
  } catch (error) {
    console.error(`[Scheduler] Error during scheduled sync for user ${userId}:`, error);
  }
}

/**
 * Sync a single repository
 */
async function syncSingleRepository(config: any, repo: any): Promise<void> {
  try {
    const repository: Repository = {
      ...repo,
      status: repoStatusEnum.parse(repo.status),
      organization: repo.organization ?? undefined,
      lastMirrored: repo.lastMirrored ?? undefined,
      errorMessage: repo.errorMessage ?? undefined,
      mirroredLocation: repo.mirroredLocation || '',
      forkedFrom: repo.forkedFrom ?? undefined,
      visibility: repositoryVisibilityEnum.parse(repo.visibility),
    };
    
    await syncGiteaRepo({ config, repository });
    console.log(`[Scheduler] Successfully synced repository ${repo.fullName}`);
  } catch (error) {
    console.error(`[Scheduler] Failed to sync repository ${repo.fullName}:`, error);
    
    // Update repository status to failed
    await db.update(repositories).set({
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      updatedAt: new Date(),
    }).where(eq(repositories.id, repo.id));
  }
}

/**
 * Check if we should auto-start based on environment configuration
 */
async function checkAutoStartConfiguration(): Promise<boolean> {
  // Don't auto-start more than once
  if (hasPerformedAutoStart) {
    return false;
  }
  
  try {
    // Check if any configuration has scheduling enabled or mirror interval set
    const activeConfigs = await db
      .select()
      .from(configs)
      .where(eq(configs.isActive, true));
    
    for (const config of activeConfigs) {
      // Check if scheduling is enabled via environment
      const scheduleEnabled = config.scheduleConfig?.enabled === true;
      const hasMirrorInterval = !!config.giteaConfig?.mirrorInterval;
      
      // If either SCHEDULE_ENABLED=true or GITEA_MIRROR_INTERVAL is set, we should auto-start
      if (scheduleEnabled || hasMirrorInterval) {
        console.log(`[Scheduler] Auto-start conditions met for user ${config.userId} (scheduleEnabled=${scheduleEnabled}, hasMirrorInterval=${hasMirrorInterval})`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('[Scheduler] Error checking auto-start configuration:', error);
    return false;
  }
}

/**
 * Perform initial auto-start: import repositories and trigger mirror
 */
async function performInitialAutoStart(): Promise<void> {
  hasPerformedAutoStart = true;
  
  try {
    console.log('[Scheduler] Performing initial auto-start...');
    
    // Get all active configurations
    const activeConfigs = await db
      .select()
      .from(configs)
      .where(eq(configs.isActive, true));
    
    for (const config of activeConfigs) {
      // Skip if tokens are not configured
      if (!config.githubConfig?.token || !config.giteaConfig?.token) {
        console.log(`[Scheduler] Skipping auto-start for user ${config.userId}: tokens not configured`);
        continue;
      }
      
      const scheduleEnabled = config.scheduleConfig?.enabled === true;
      const hasMirrorInterval = !!config.giteaConfig?.mirrorInterval;
      
      // Only process configs that have scheduling or mirror interval configured
      if (!scheduleEnabled && !hasMirrorInterval) {
        continue;
      }
      
      console.log(`[Scheduler] Auto-starting for user ${config.userId}...`);
      
      try {
        // Step 1: Import repositories from GitHub
        console.log(`[Scheduler] Step 1: Importing repositories from GitHub for user ${config.userId}...`);
        const { getGithubRepositories, getGithubStarredRepositories } = await import('@/lib/github');
        const { v4: uuidv4 } = await import('uuid');
        
        // Create GitHub client
        const decryptedToken = getDecryptedGitHubToken(config);
        const { Octokit } = await import('@octokit/rest');
        const octokit = new Octokit({ auth: decryptedToken });
        
        // Fetch GitHub data
        const [basicAndForkedRepos, starredRepos] = await Promise.all([
          getGithubRepositories({ octokit, config }),
          config.githubConfig?.includeStarred
            ? getGithubStarredRepositories({ octokit, config })
            : Promise.resolve([]),
        ]);
        const allGithubRepos = mergeGitReposPreferStarred(basicAndForkedRepos, starredRepos);
        const mirrorableGithubRepos = allGithubRepos.filter(isMirrorableGitHubRepo);
        
        // Check for new repositories
        const existingRepos = await db
          .select({ normalizedFullName: repositories.normalizedFullName })
          .from(repositories)
          .where(eq(repositories.userId, config.userId));
        
        const existingRepoNames = new Set(existingRepos.map(r => r.normalizedFullName));
        const reposToImport = mirrorableGithubRepos.filter(r => !existingRepoNames.has(r.fullName.toLowerCase()));
        
        if (reposToImport.length > 0) {
          console.log(`[Scheduler] Importing ${reposToImport.length} repositories for user ${config.userId}...`);
          
          // Insert new repositories
          const reposToInsert = reposToImport.map(repo => 
            normalizeGitRepoToInsert(repo, { userId: config.userId, configId: config.id })
          );
          
          // Batch insert to avoid SQLite parameter limit
          const sample = reposToInsert[0];
          const columnCount = Object.keys(sample ?? {}).length || 1;
          const BATCH_SIZE = calcBatchSizeForInsert(columnCount);
          for (let i = 0; i < reposToInsert.length; i += BATCH_SIZE) {
            const batch = reposToInsert.slice(i, i + BATCH_SIZE);
            await db
              .insert(repositories)
              .values(batch)
              .onConflictDoNothing({ target: [repositories.userId, repositories.normalizedFullName] });
          }
          console.log(`[Scheduler] Successfully imported ${reposToImport.length} repositories`);
        } else {
          console.log(`[Scheduler] No new repositories to import for user ${config.userId}`);
        }
        const skippedDisabledCount = allGithubRepos.length - mirrorableGithubRepos.length;
        if (skippedDisabledCount > 0) {
          console.log(`[Scheduler] Skipped ${skippedDisabledCount} disabled GitHub repositories for user ${config.userId}`);
        }
        
        // Check if we already have mirrored repositories (indicating this isn't first run)
        const mirroredRepos = await db
          .select()
          .from(repositories)
          .where(
            and(
              eq(repositories.userId, config.userId),
              or(
                eq(repositories.status, 'mirrored'),
                eq(repositories.status, 'synced')
              )
            )
          )
          .limit(1);
        
        // If we already have mirrored repos, skip the initial mirror (let regular sync handle it)
        if (mirroredRepos.length > 0) {
          console.log(`[Scheduler] User ${config.userId} already has mirrored repositories, skipping initial mirror (let regular sync handle updates)`);
          
          // Still update the schedule config to indicate scheduling is active
          const currentTime = new Date();
          const intervalSource = config.scheduleConfig?.interval || 
                                config.giteaConfig?.mirrorInterval || 
                                '8h';
          const interval = parseScheduleInterval(intervalSource);
          const nextRun = new Date(currentTime.getTime() + interval);
          
          await db.update(configs).set({
            scheduleConfig: {
              ...config.scheduleConfig,
              enabled: true,
              lastRun: currentTime,
              nextRun: nextRun,
            },
            updatedAt: currentTime,
          }).where(eq(configs.id, config.id));
          
          console.log(`[Scheduler] Scheduling enabled for user ${config.userId}, next sync at ${nextRun.toISOString()}`);
          continue;
        }
        
        // Step 2: Trigger mirror for all repositories that need mirroring
        console.log(`[Scheduler] Step 2: Triggering mirror for repositories that need mirroring...`);
        const reposNeedingMirror = await db
          .select()
          .from(repositories)
          .where(
            and(
              eq(repositories.userId, config.userId),
              or(
                eq(repositories.status, 'imported'),
                eq(repositories.status, 'pending'),
                eq(repositories.status, 'failed')
              )
            )
          );
        
        if (reposNeedingMirror.length > 0) {
          console.log(`[Scheduler] Found ${reposNeedingMirror.length} repositories that need mirroring`);
          
          // Reuse the octokit instance from above
          // (octokit was already created in the import phase)
          
          // Process repositories in batches
          const batchSize = config.scheduleConfig?.batchSize || 5;
          for (let i = 0; i < reposNeedingMirror.length; i += batchSize) {
            const batch = reposNeedingMirror.slice(i, Math.min(i + batchSize, reposNeedingMirror.length));
            console.log(`[Scheduler] Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(reposNeedingMirror.length / batchSize)} (${batch.length} repos)`);
            
            await Promise.all(
              batch.map(async (repo) => {
                try {
                  const repository: Repository = {
                    ...repo,
                    status: repoStatusEnum.parse(repo.status),
                    organization: repo.organization ?? undefined,
                    lastMirrored: repo.lastMirrored ?? undefined,
                    errorMessage: repo.errorMessage ?? undefined,
                    mirroredLocation: repo.mirroredLocation || '',
                    forkedFrom: repo.forkedFrom ?? undefined,
                    visibility: repositoryVisibilityEnum.parse(repo.visibility),
                  };
                  
                  await mirrorGithubRepoToGitea({ 
                    octokit,
                    repository,
                    config
                  });
                  console.log(`[Scheduler] Successfully mirrored repository: ${repo.fullName}`);
                } catch (error) {
                  console.error(`[Scheduler] Failed to mirror repository ${repo.fullName}:`, error);
                }
              })
            );
            
            // Pause between batches if configured
            if (i + batchSize < reposNeedingMirror.length) {
              const pauseTime = config.scheduleConfig?.pauseBetweenBatches || 2000;
              console.log(`[Scheduler] Pausing for ${pauseTime}ms before next batch...`);
              await new Promise(resolve => setTimeout(resolve, pauseTime));
            }
          }
          
          console.log(`[Scheduler] Completed initial mirror for ${reposNeedingMirror.length} repositories`);
        } else {
          console.log(`[Scheduler] No repositories need mirroring`);
        }
        
        // Update the schedule config to indicate we've run
        const currentTime = new Date();
        const intervalSource = config.scheduleConfig?.interval || 
                              config.giteaConfig?.mirrorInterval || 
                              '8h';
        const interval = parseScheduleInterval(intervalSource);
        const nextRun = new Date(currentTime.getTime() + interval);
        
        await db.update(configs).set({
          scheduleConfig: {
            ...config.scheduleConfig,
            enabled: true, // Ensure scheduling is enabled
            lastRun: currentTime,
            nextRun: nextRun,
          },
          updatedAt: currentTime,
        }).where(eq(configs.id, config.id));
        
        console.log(`[Scheduler] Auto-start completed for user ${config.userId}, next sync at ${nextRun.toISOString()}`);
        
      } catch (error) {
        console.error(`[Scheduler] Failed to auto-start for user ${config.userId}:`, error);
      }
    }
    
    console.log('[Scheduler] Initial auto-start completed');
  } catch (error) {
    console.error('[Scheduler] Failed to perform initial auto-start:', error);
  }
}

/**
 * Main scheduler loop
 */
async function schedulerLoop(): Promise<void> {
  if (isSchedulerRunning) {
    console.log('[Scheduler] Scheduler is already running, skipping this cycle');
    return;
  }
  
  isSchedulerRunning = true;
  
  try {
    // Get all active configurations with scheduling enabled
    const activeConfigs = await db
      .select()
      .from(configs)
      .where(
        and(
          eq(configs.isActive, true)
        )
      );
    
    const enabledConfigs = activeConfigs.filter(config => 
      config.scheduleConfig?.enabled === true
    );
    
    // Further filter configs that have valid tokens
    const validConfigs = enabledConfigs.filter(config => {
      const hasGitHubToken = !!config.githubConfig?.token;
      const hasGiteaToken = !!config.giteaConfig?.token;
      
      if (!hasGitHubToken || !hasGiteaToken) {
        console.log(`[Scheduler] User ${config.userId}: Scheduling enabled but tokens missing (GitHub: ${hasGitHubToken}, Gitea: ${hasGiteaToken})`);
        return false;
      }
      return true;
    });
    
    if (validConfigs.length === 0) {
      if (enabledConfigs.length > 0) {
        console.log(`[Scheduler] ${enabledConfigs.length} config(s) have scheduling enabled but lack required tokens`);
      } else {
        console.log(`[Scheduler] No configurations with scheduling enabled (found ${activeConfigs.length} active configs)`);
        
        // Show details about why configs are not enabled
        activeConfigs.forEach(config => {
          const scheduleEnabled = config.scheduleConfig?.enabled;
          const mirrorInterval = config.giteaConfig?.mirrorInterval;
          console.log(`[Scheduler] User ${config.userId}: scheduleEnabled=${scheduleEnabled}, mirrorInterval=${mirrorInterval}`);
        });
      }
      
      return;
    }
    
    console.log(`[Scheduler] Processing ${validConfigs.length} valid configurations (out of ${enabledConfigs.length} with scheduling enabled)`);
    
    // Check each configuration to see if it's time to run
    const currentTime = new Date();
    
    for (const config of validConfigs) {
      const scheduleConfig = config.scheduleConfig || {};
      
      // Check if it's time to run based on nextRun
      if (scheduleConfig.nextRun && new Date(scheduleConfig.nextRun) > currentTime) {
        console.log(`[Scheduler] Skipping user ${config.userId} - next run at ${scheduleConfig.nextRun}`);
        continue;
      }
      
      // If no nextRun is set, or it's past due, run the sync
      await runScheduledSync(config);
    }
  } catch (error) {
    console.error('[Scheduler] Error in scheduler loop:', error);
  } finally {
    isSchedulerRunning = false;
  }
}

/**
 * Start the scheduler service
 */
export async function startSchedulerService(): Promise<void> {
  if (schedulerInterval) {
    console.log('[Scheduler] Scheduler service is already running');
    return;
  }
  
  console.log('[Scheduler] Starting scheduler service');
  
  // Check if we should auto-start mirroring based on environment variables
  const shouldAutoStart = await checkAutoStartConfiguration();
  
  if (shouldAutoStart) {
    console.log('[Scheduler] Auto-start detected from environment variables, triggering initial import and mirror...');
    await performInitialAutoStart();
  }
  
  // Run immediately on start
  schedulerLoop().catch(error => {
    console.error('[Scheduler] Error during initial scheduler run:', error);
  });
  
  // Run every minute to check for scheduled tasks
  const checkInterval = 60 * 1000; // 1 minute
  schedulerInterval = setInterval(() => {
    schedulerLoop().catch(error => {
      console.error('[Scheduler] Error during scheduler run:', error);
    });
  }, checkInterval);
  
  console.log(`[Scheduler] Scheduler service started, checking every ${formatDuration(checkInterval)} for scheduled tasks`);
  console.log('[Scheduler] To trigger manual sync, check your configuration intervals and ensure SCHEDULE_ENABLED=true or use GITEA_MIRROR_INTERVAL');
}

/**
 * Stop the scheduler service
 */
export function stopSchedulerService(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Scheduler service stopped');
  }
}

/**
 * Check if the scheduler service is running
 */
export function isSchedulerServiceRunning(): boolean {
  return schedulerInterval !== null;
}
