/**
 * Recovery mechanism for interrupted jobs
 * This module handles detecting and resuming jobs that were interrupted by container restarts
 */

import { findInterruptedJobs, resumeInterruptedJob } from './helpers';
import { resetStuckMirrorStatuses } from './stuck-status-recovery';
import { db, repositories, organizations, mirrorJobs, configs } from './db';
import { eq, and, lt, inArray, sql } from 'drizzle-orm';
import { mirrorGithubRepoToGitea, mirrorGitHubOrgRepoToGiteaOrg, syncGiteaRepo } from './gitea';
import { createGitHubClient } from './github';
import { processWithResilience } from './utils/concurrency';
import { repositoryVisibilityEnum, repoStatusEnum } from '@/types/Repository';
import type { Repository } from './db/schema';
import { getDecryptedGitHubToken } from './utils/config-encryption';

// Recovery state tracking
let recoveryInProgress = false;
let lastRecoveryAttempt: Date | null = null;

/**
 * Validates database connection before attempting recovery
 */
async function validateDatabaseConnection(): Promise<boolean> {
  try {
    // Simple query to test database connectivity
    await db.select().from(mirrorJobs).limit(1);
    return true;
  } catch (error) {
    console.error('Database connection validation failed:', error);
    return false;
  }
}

/**
 * Cleans up stale jobs that are too old to recover
 */
async function cleanupStaleJobs(): Promise<void> {
  try {
    const staleThreshold = new Date();
    staleThreshold.setHours(staleThreshold.getHours() - 24); // Jobs older than 24 hours

    const staleJobs = await db
      .select()
      .from(mirrorJobs)
      .where(
        and(
          eq(mirrorJobs.inProgress, true),
          lt(mirrorJobs.startedAt, staleThreshold)
        )
      );

    if (staleJobs.length > 0) {
      console.log(`Found ${staleJobs.length} stale jobs to clean up`);

      // Mark stale jobs as failed
      await db
        .update(mirrorJobs)
        .set({
          inProgress: false,
          completedAt: new Date(),
          status: "failed",
          message: "Job marked as failed due to being stale (older than 24 hours)"
        })
        .where(
          and(
            eq(mirrorJobs.inProgress, true),
            lt(mirrorJobs.startedAt, staleThreshold)
          )
        );

      console.log(`Cleaned up ${staleJobs.length} stale jobs`);
    }
  } catch (error) {
    console.error('Error cleaning up stale jobs:', error);
  }
}

/**
 * Initialize the recovery system with enhanced error handling and resilience
 * This should be called when the application starts
 */
export async function initializeRecovery(options: {
  maxRetries?: number;
  retryDelay?: number;
  skipIfRecentAttempt?: boolean;
} = {}): Promise<boolean> {
  const { maxRetries = 3, retryDelay = 5000, skipIfRecentAttempt = true } = options;

  // Prevent concurrent recovery attempts
  if (recoveryInProgress) {
    console.log('Recovery already in progress, skipping...');
    return false;
  }

  // Skip if recent attempt (within last 5 minutes) unless forced
  if (skipIfRecentAttempt && lastRecoveryAttempt) {
    const timeSinceLastAttempt = Date.now() - lastRecoveryAttempt.getTime();
    if (timeSinceLastAttempt < 5 * 60 * 1000) {
      console.log('Recent recovery attempt detected, skipping...');
      return false;
    }
  }

  recoveryInProgress = true;
  lastRecoveryAttempt = new Date();

  console.log('Initializing recovery system...');

  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      attempt++;
      console.log(`Recovery attempt ${attempt}/${maxRetries}`);

      // Validate database connection first
      const dbConnected = await validateDatabaseConnection();
      if (!dbConnected) {
        throw new Error('Database connection validation failed');
      }

      // Clean up stale jobs first
      await cleanupStaleJobs();

      // Reset repositories/organizations stuck in an in-flight status
      // ("mirroring"/"syncing") with no live process behind them (issue
      // #339). Job-level recovery below only reconciles mirrorJobs rows;
      // repository.status is never reconciled by it, so rows orphaned by
      // a crash would otherwise stay "syncing" forever. Never throws.
      await resetStuckMirrorStatuses();

      // Find interrupted jobs (with per-job logging — this is the
      // active recovery path that will immediately try to resume them)
      const interruptedJobs = await findInterruptedJobs({ logFound: true });

      if (interruptedJobs.length === 0) {
        console.log('No interrupted jobs found.');
        recoveryInProgress = false;
        return true;
      }

      console.log(`Found ${interruptedJobs.length} interrupted jobs. Starting recovery...`);

      // Process each interrupted job with individual error handling
      let successCount = 0;
      let failureCount = 0;

      for (const job of interruptedJobs) {
        try {
          const resumeData = await resumeInterruptedJob(job);

          if (!resumeData) {
            console.log(`Job ${job.id} could not be resumed.`);
            failureCount++;
            continue;
          }

          const { job: updatedJob, remainingItemIds } = resumeData;

          // Handle different job types
          switch (updatedJob.jobType) {
            case 'mirror':
              await recoverMirrorJob(updatedJob, remainingItemIds);
              break;
            case 'sync':
              await recoverSyncJob(updatedJob, remainingItemIds);
              break;
            case 'retry':
              await recoverRetryJob(updatedJob, remainingItemIds);
              break;
            default:
              console.log(`Unknown job type: ${updatedJob.jobType}`);
              failureCount++;
              continue;
          }

          successCount++;
        } catch (jobError) {
          console.error(`Error recovering individual job ${job.id}:`, jobError);
          failureCount++;

          // Mark the job as failed if recovery fails
          try {
            await db
              .update(mirrorJobs)
              .set({
                inProgress: false,
                completedAt: new Date(),
                status: "failed",
                message: `Job recovery failed: ${jobError instanceof Error ? jobError.message : String(jobError)}`
              })
              .where(eq(mirrorJobs.id, job.id));
          } catch (updateError) {
            console.error(`Failed to mark job ${job.id} as failed:`, updateError);
          }
        }
      }

      console.log(`Recovery process completed. Success: ${successCount}, Failures: ${failureCount}`);
      recoveryInProgress = false;
      return true;

    } catch (error) {
      console.error(`Recovery attempt ${attempt} failed:`, error);

      if (attempt < maxRetries) {
        console.log(`Retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        console.error('All recovery attempts failed');
        recoveryInProgress = false;
        return false;
      }
    }
  }

  recoveryInProgress = false;
  return false;
}

/**
 * Recover a mirror job with enhanced error handling
 */
async function recoverMirrorJob(job: any, remainingItemIds: string[]) {
  console.log(`Recovering mirror job ${job.id} with ${remainingItemIds.length} remaining items`);

  try {
    // Get the config for this user — prefer active and most-recently-updated
    // to avoid picking a stale inactive stub when multiple rows exist (see issue #271).
    const userConfigs = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, job.userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    if (userConfigs.length === 0) {
      throw new Error(`No configuration found for user ${job.userId}`);
    }

    const config = userConfigs[0];
    if (!config.id) {
      throw new Error(`Configuration missing id for user ${job.userId}`);
    }

    // Get repositories to process with validation
    const repos = await db
      .select()
      .from(repositories)
      .where(inArray(repositories.id, remainingItemIds));

    if (repos.length === 0) {
      console.warn(`No repositories found for remaining item IDs: ${remainingItemIds.join(', ')}`);
      // Mark job as completed since there's nothing to process
      await db
        .update(mirrorJobs)
        .set({
          inProgress: false,
          completedAt: new Date(),
          status: "mirrored",
          message: "Job completed - no repositories found to process"
        })
        .where(eq(mirrorJobs.id, job.id));
      return;
    }

    console.log(`Found ${repos.length} repositories to process for recovery`);

    // Validate GitHub configuration before creating client
    if (!config.githubConfig?.token) {
      throw new Error('GitHub token not found in configuration');
    }

    // Create GitHub client with error handling and rate limit tracking
    let octokit;
    try {
      const decryptedToken = getDecryptedGitHubToken(config);
      const githubUsername = config.githubConfig?.owner || undefined;
      const userId = config.userId || undefined;
      octokit = createGitHubClient(decryptedToken, userId, githubUsername);
    } catch (error) {
      throw new Error(`Failed to create GitHub client: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Process repositories with resilience and reduced concurrency for recovery
    await processWithResilience(
      repos,
      async (repo) => {
        // Prepare repository data with validation
        const repoData = {
          ...repo,
          status: repoStatusEnum.parse("imported"),
          organization: repo.organization ?? undefined,
          lastMirrored: repo.lastMirrored ?? undefined,
          errorMessage: repo.errorMessage ?? undefined,
          forkedFrom: repo.forkedFrom ?? undefined,
          visibility: repositoryVisibilityEnum.parse(repo.visibility || "public"),
          mirroredLocation: repo.mirroredLocation || "",
        };

        // Mirror the repository based on whether it's in an organization
        if (repo.organization && config.giteaConfig.preserveOrgStructure) {
          await mirrorGitHubOrgRepoToGiteaOrg({
            config,
            octokit,
            orgName: repo.organization,
            repository: repoData,
          });
        } else {
          await mirrorGithubRepoToGitea({
            octokit,
            repository: repoData,
            config,
          });
        }

        return repo;
      },
      {
        userId: job.userId,
        jobType: 'mirror',
        getItemId: (repo) => repo.id,
        getItemName: (repo) => repo.name,
        resumeFromJobId: job.id,
        concurrencyLimit: 2, // Reduced concurrency for recovery to be more stable
        maxRetries: 3, // Increased retries for recovery
        retryDelay: 3000, // Longer delay for recovery
      }
    );

    console.log(`Successfully recovered mirror job ${job.id}`);
  } catch (error) {
    console.error(`Error recovering mirror job ${job.id}:`, error);

    // Mark the job as failed
    try {
      await db
        .update(mirrorJobs)
        .set({
          inProgress: false,
          completedAt: new Date(),
          status: "failed",
          message: `Mirror job recovery failed: ${error instanceof Error ? error.message : String(error)}`
        })
        .where(eq(mirrorJobs.id, job.id));
    } catch (updateError) {
      console.error(`Failed to mark mirror job ${job.id} as failed:`, updateError);
    }

    throw error; // Re-throw to be handled by the caller
  }
}

/**
 * Recover a sync job with enhanced error handling
 */
async function recoverSyncJob(job: any, remainingItemIds: string[]) {
  console.log(`Recovering sync job ${job.id} with ${remainingItemIds.length} remaining items`);

  try {
    // Get the config for this user — prefer active and most-recently-updated
    // to avoid picking a stale inactive stub when multiple rows exist (see issue #271).
    const userConfigs = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, job.userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    if (userConfigs.length === 0) {
      throw new Error(`No configuration found for user ${job.userId}`);
    }

    const config = userConfigs[0];
    if (!config.id) {
      throw new Error(`Configuration missing id for user ${job.userId}`);
    }

    // Get repositories to process with validation
    const repos = await db
      .select()
      .from(repositories)
      .where(inArray(repositories.id, remainingItemIds));

    if (repos.length === 0) {
      console.warn(`No repositories found for remaining item IDs: ${remainingItemIds.join(', ')}`);
      // Mark job as completed since there's nothing to process
      await db
        .update(mirrorJobs)
        .set({
          inProgress: false,
          completedAt: new Date(),
          status: "mirrored",
          message: "Job completed - no repositories found to process"
        })
        .where(eq(mirrorJobs.id, job.id));
      return;
    }

    console.log(`Found ${repos.length} repositories to process for sync recovery`);

    // Process repositories with resilience and reduced concurrency for recovery
    await processWithResilience(
      repos,
      async (repo) => {
        // Prepare repository data with validation
        const repoData = {
          ...repo,
          status: repoStatusEnum.parse(repo.status || "imported"),
          organization: repo.organization ?? undefined,
          lastMirrored: repo.lastMirrored ?? undefined,
          errorMessage: repo.errorMessage ?? undefined,
          forkedFrom: repo.forkedFrom ?? undefined,
          visibility: repositoryVisibilityEnum.parse(repo.visibility || "public"),
          mirroredLocation: repo.mirroredLocation || "",
        };

        // Sync the repository
        await syncGiteaRepo({
          config,
          repository: repoData,
        });

        return repo;
      },
      {
        userId: job.userId,
        jobType: 'sync',
        getItemId: (repo) => repo.id,
        getItemName: (repo) => repo.name,
        resumeFromJobId: job.id,
        concurrencyLimit: 3, // Reduced concurrency for recovery
        maxRetries: 3, // Increased retries for recovery
        retryDelay: 3000, // Longer delay for recovery
      }
    );

    console.log(`Successfully recovered sync job ${job.id}`);
  } catch (error) {
    console.error(`Error recovering sync job ${job.id}:`, error);

    // Mark the job as failed
    try {
      await db
        .update(mirrorJobs)
        .set({
          inProgress: false,
          completedAt: new Date(),
          status: "failed",
          message: `Sync job recovery failed: ${error instanceof Error ? error.message : String(error)}`
        })
        .where(eq(mirrorJobs.id, job.id));
    } catch (updateError) {
      console.error(`Failed to mark sync job ${job.id} as failed:`, updateError);
    }

    throw error; // Re-throw to be handled by the caller
  }
}

/**
 * Recover a retry job with enhanced error handling
 */
async function recoverRetryJob(job: any, remainingItemIds: string[]) {
  console.log(`Recovering retry job ${job.id} with ${remainingItemIds.length} remaining items`);

  try {
    // For now, retry jobs are treated similarly to mirror jobs
    // In the future, this could have specific retry logic
    await recoverMirrorJob(job, remainingItemIds);
    console.log(`Successfully recovered retry job ${job.id}`);
  } catch (error) {
    console.error(`Error recovering retry job ${job.id}:`, error);

    // Mark the job as failed
    try {
      await db
        .update(mirrorJobs)
        .set({
          inProgress: false,
          completedAt: new Date(),
          status: "failed",
          message: `Retry job recovery failed: ${error instanceof Error ? error.message : String(error)}`
        })
        .where(eq(mirrorJobs.id, job.id));
    } catch (updateError) {
      console.error(`Failed to mark retry job ${job.id} as failed:`, updateError);
    }

    throw error; // Re-throw to be handled by the caller
  }
}

/**
 * Get recovery system status
 */
export function getRecoveryStatus() {
  return {
    inProgress: recoveryInProgress,
    lastAttempt: lastRecoveryAttempt,
  };
}

/**
 * Force recovery to run (bypassing recent attempt check)
 */
export async function forceRecovery(): Promise<boolean> {
  return initializeRecovery({ skipIfRecentAttempt: false });
}

/**
 * Check if there are any jobs that need recovery
 */
export async function hasJobsNeedingRecovery(): Promise<boolean> {
  try {
    const interruptedJobs = await findInterruptedJobs();
    return interruptedJobs.length > 0;
  } catch (error) {
    console.error('Error checking for jobs needing recovery:', error);
    return false;
  }
}
