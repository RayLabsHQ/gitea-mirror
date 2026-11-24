/**
 * Background cleanup service for automatic database maintenance
 * This service runs periodically to clean up old events and mirror jobs
 * based on user configuration settings
 */

import { db, configs, events, mirrorJobs } from "@/lib/db";
import { eq, lt, and } from "drizzle-orm";
import { cleanupIntervalHours } from "@/lib/utils/cleanup-schedule";

interface CleanupResult {
  userId: string;
  eventsDeleted: number;
  mirrorJobsDeleted: number;
  error?: string;
}

/**
 * Hours between runs for a retention period in seconds. Kept as an export for
 * existing callers; the rule lives in cleanup-schedule.ts.
 */
export function calculateCleanupInterval(retentionSeconds: number): number {
  return cleanupIntervalHours(retentionSeconds);
}

/**
 * Clean up old events and mirror jobs for a specific user
 * @param retentionSeconds - Retention period in seconds
 */
async function cleanupForUser(userId: string, retentionSeconds: number): Promise<CleanupResult> {
  try {
    const retentionDays = retentionSeconds / (24 * 60 * 60); // Convert to days for logging
    console.log(`Running cleanup for user ${userId} with ${retentionDays} days retention (${retentionSeconds} seconds)`);

    // Calculate cutoff date using seconds
    const cutoffDate = new Date();
    cutoffDate.setTime(cutoffDate.getTime() - retentionSeconds * 1000);

    let eventsDeleted = 0;
    let mirrorJobsDeleted = 0;

    // Clean up old events
    const deletedEvents: any = await db
      .delete(events)
      .where(
        and(
          eq(events.userId, userId),
          lt(events.createdAt, cutoffDate)
        )
      );
    eventsDeleted = Number(deletedEvents?.changes ?? 0);

    // Clean up old mirror jobs (only completed ones)
    const deletedJobs: any = await db
      .delete(mirrorJobs)
      .where(
        and(
          eq(mirrorJobs.userId, userId),
          eq(mirrorJobs.inProgress, false),
          lt(mirrorJobs.timestamp, cutoffDate)
        )
      );
    mirrorJobsDeleted = Number(deletedJobs?.changes ?? 0);

    console.log(`Cleanup completed for user ${userId}: ${eventsDeleted} events, ${mirrorJobsDeleted} jobs deleted`);

    return {
      userId,
      eventsDeleted,
      mirrorJobsDeleted,
    };
  } catch (error) {
    console.error(`Error during cleanup for user ${userId}:`, error);
    return {
      userId,
      eventsDeleted: 0,
      mirrorJobsDeleted: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Record a run on the config row: the last run is now and the next one is a
 * full interval away.
 */
async function updateCleanupConfig(configId: string, userId: string, cleanupConfig: any) {
  const now = new Date();
  const retentionSeconds = cleanupConfig.retentionDays || 604800; // Default 7 days in seconds
  const intervalHours = calculateCleanupInterval(retentionSeconds);
  const nextRun = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
  try {
    await db
      .update(configs)
      .set({
        cleanupConfig: { ...cleanupConfig, lastRun: now, nextRun },
        updatedAt: now,
      })
      .where(eq(configs.id, configId));

    const retentionDays = retentionSeconds / (24 * 60 * 60);
    console.log(`Updated cleanup config for user ${userId}, next run: ${nextRun.toISOString()} (${intervalHours}h interval for ${retentionDays}d retention)`);
  } catch (error) {
    console.error(`Error updating cleanup config for user ${userId}:`, error);
  }
  return { lastRun: now, nextRun };
}

/**
 * Run database maintenance for one user right away, from the Run now button
 * (#547). It uses the saved retention period, and the next scheduled run
 * moves to a full interval from now.
 */
export async function runDatabaseCleanupNow(
  userId: string
): Promise<CleanupResult & { lastRun: Date; nextRun: Date }> {
  const [config] = await db
    .select()
    .from(configs)
    .where(and(eq(configs.userId, userId), eq(configs.isActive, true)))
    .limit(1);
  if (!config) {
    throw new Error("No active configuration found for user");
  }
  const cleanupConfig: any = config.cleanupConfig || {};
  const result = await cleanupForUser(userId, cleanupConfig.retentionDays || 604800);
  if (result.error) {
    throw new Error(result.error);
  }
  const times = await updateCleanupConfig(config.id, userId, cleanupConfig);
  return { ...result, ...times };
}

/**
 * Run automatic cleanup for all users with cleanup enabled
 */
export async function runAutomaticCleanup(): Promise<CleanupResult[]> {
  try {
    console.log('Starting automatic cleanup service...');

    // Get all users with cleanup enabled
    const userConfigs = await db
      .select()
      .from(configs)
      .where(eq(configs.isActive, true));

    const results: CleanupResult[] = [];
    const now = new Date();

    for (const config of userConfigs) {
      try {
        const cleanupConfig = config.cleanupConfig;

        // Skip if cleanup is not enabled
        if (!cleanupConfig?.enabled) {
          continue;
        }

        // Check if it's time to run cleanup
        const nextRun = cleanupConfig.nextRun ? new Date(cleanupConfig.nextRun) : null;

        // If nextRun is null or in the past, run cleanup
        if (!nextRun || now >= nextRun) {
          const result = await cleanupForUser(config.userId, cleanupConfig.retentionDays || 604800);
          results.push(result);

          // Update the cleanup config with new run times
          await updateCleanupConfig(config.id, config.userId, cleanupConfig);
        } else {
          console.log(`Skipping cleanup for user ${config.userId}, next run: ${nextRun.toISOString()}`);
        }
      } catch (error) {
        console.error(`Error processing cleanup for user ${config.userId}:`, error);
        results.push({
          userId: config.userId,
          eventsDeleted: 0,
          mirrorJobsDeleted: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    console.log(`Automatic cleanup completed. Processed ${results.length} users.`);
    return results;
  } catch (error) {
    console.error('Error in automatic cleanup service:', error);
    return [];
  }
}

// Service state tracking
let cleanupIntervalId: NodeJS.Timeout | null = null;
let initialCleanupTimeoutId: NodeJS.Timeout | null = null;
let cleanupServiceRunning = false;

/**
 * Start the cleanup service with periodic execution
 * This should be called when the application starts
 */
export function startCleanupService() {
  if (cleanupServiceRunning) {
    console.log('⚠️  Cleanup service already running, skipping start');
    return;
  }

  console.log('Starting background cleanup service...');

  // Run cleanup every hour
  const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds

  // Run initial cleanup after 5 minutes to allow app to fully start
  initialCleanupTimeoutId = setTimeout(() => {
    runAutomaticCleanup().catch(error => {
      console.error('Error in initial cleanup run:', error);
    });
  }, 5 * 60 * 1000); // 5 minutes

  // Set up periodic cleanup
  cleanupIntervalId = setInterval(() => {
    runAutomaticCleanup().catch(error => {
      console.error('Error in periodic cleanup run:', error);
    });
  }, CLEANUP_INTERVAL);

  cleanupServiceRunning = true;
  console.log(`✅ Cleanup service started. Will run every ${CLEANUP_INTERVAL / 1000 / 60} minutes.`);
}

/**
 * Stop the cleanup service (for testing or shutdown)
 */
export function stopCleanupService() {
  if (!cleanupServiceRunning) {
    console.log('Cleanup service is not running');
    return;
  }

  console.log('🛑 Stopping cleanup service...');

  // Clear the periodic interval
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Clear the initial timeout
  if (initialCleanupTimeoutId) {
    clearTimeout(initialCleanupTimeoutId);
    initialCleanupTimeoutId = null;
  }

  cleanupServiceRunning = false;
  console.log('✅ Cleanup service stopped');
}

/**
 * Get cleanup service status
 */
export function getCleanupServiceStatus() {
  return {
    running: cleanupServiceRunning,
    hasInterval: cleanupIntervalId !== null,
    hasInitialTimeout: initialCleanupTimeoutId !== null,
  };
}
