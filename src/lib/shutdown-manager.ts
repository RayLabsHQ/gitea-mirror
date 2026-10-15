/**
 * Shutdown Manager for Graceful Application Termination
 *
 * This module provides centralized shutdown coordination for the gitea-mirror application.
 * It ensures that:
 * - In-progress jobs are properly saved to the database
 * - Database connections are closed cleanly
 * - Background services are stopped gracefully
 * - No data loss occurs during container restarts
 */

import { db, mirrorJobs } from './db';
import { eq, and } from 'drizzle-orm';
import type { MirrorJob } from './db/schema';

// Shutdown state tracking
let shutdownInProgress = false;
let shutdownStartTime: Date | null = null;
let shutdownCallbacks: Array<() => Promise<void>> = [];
let activeJobs = new Set<string>();
let shutdownTimeout: NodeJS.Timeout | null = null;

// Configuration
const SHUTDOWN_TIMEOUT = 30000; // 30 seconds max shutdown time
const JOB_SAVE_TIMEOUT = 10000; // 10 seconds to save job state

/**
 * Register a callback to be executed during shutdown
 */
export function registerShutdownCallback(callback: () => Promise<void>): void {
  shutdownCallbacks.push(callback);
}

/**
 * Register an active job that needs to be tracked during shutdown
 */
export function registerActiveJob(jobId: string): void {
  activeJobs.add(jobId);
  console.log(`Registered active job: ${jobId} (${activeJobs.size} total active jobs)`);
}

/**
 * Unregister a job when it completes normally
 */
export function unregisterActiveJob(jobId: string): void {
  activeJobs.delete(jobId);
  console.log(`Unregistered job: ${jobId} (${activeJobs.size} remaining active jobs)`);
}

/**
 * Check if shutdown is currently in progress
 */
export function isShuttingDown(): boolean {
  return shutdownInProgress;
}

/**
 * Get shutdown status information
 */
export function getShutdownStatus() {
  return {
    inProgress: shutdownInProgress,
    startTime: shutdownStartTime,
    activeJobs: Array.from(activeJobs),
    registeredCallbacks: shutdownCallbacks.length,
  };
}

/**
 * Save the current state of an active job to the database
 */
async function saveJobState(jobId: string): Promise<void> {
  try {
    console.log(`Saving state for job ${jobId}...`);

    // Update the job to mark it as interrupted but not failed
    await db
      .update(mirrorJobs)
      .set({
        inProgress: false,
        lastCheckpoint: new Date(),
        message: 'Job interrupted by application shutdown - will resume on restart',
      })
      .where(eq(mirrorJobs.id, jobId));

    console.log(`✅ Saved state for job ${jobId}`);
  } catch (error) {
    console.error(`❌ Failed to save state for job ${jobId}:`, error);
    throw error;
  }
}

/**
 * Save all active jobs to the database
 */
async function saveAllActiveJobs(): Promise<void> {
  if (activeJobs.size === 0) {
    console.log('No active jobs to save');
    return;
  }

  console.log(`Saving state for ${activeJobs.size} active jobs...`);

  const savePromises = Array.from(activeJobs).map(async (jobId) => {
    try {
      await Promise.race([
        saveJobState(jobId),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Timeout saving job ${jobId}`)), JOB_SAVE_TIMEOUT);
        })
      ]);
    } catch (error) {
      console.error(`Failed to save job ${jobId} within timeout:`, error);
      // Continue with other jobs even if one fails
    }
  });

  await Promise.allSettled(savePromises);
  console.log('✅ Completed saving all active jobs');
}

/**
 * Execute all registered shutdown callbacks
 */
async function executeShutdownCallbacks(): Promise<void> {
  if (shutdownCallbacks.length === 0) {
    console.log('No shutdown callbacks to execute');
    return;
  }

  console.log(`Executing ${shutdownCallbacks.length} shutdown callbacks...`);

  const callbackPromises = shutdownCallbacks.map(async (callback, index) => {
    try {
      await callback();
      console.log(`✅ Shutdown callback ${index + 1} completed`);
    } catch (error) {
      console.error(`❌ Shutdown callback ${index + 1} failed:`, error);
      // Continue with other callbacks even if one fails
    }
  });

  await Promise.allSettled(callbackPromises);
  console.log('✅ Completed all shutdown callbacks');
}

/**
 * Perform graceful shutdown of the application
 */
/** Exit status for a completed shutdown: 1 after a crash, 0 after a signal. */
export function shutdownExitCode(signal: string): number {
  return signal === 'UNCAUGHT_EXCEPTION' || signal === 'UNHANDLED_REJECTION' ? 1 : 0;
}

export async function gracefulShutdown(signal: string = 'UNKNOWN'): Promise<void> {
  if (shutdownInProgress) {
    console.log('⚠️  Shutdown already in progress, ignoring additional signal');
    return;
  }

  shutdownInProgress = true;
  shutdownStartTime = new Date();

  console.log(`\n🛑 Graceful shutdown initiated by signal: ${signal}`);
  console.log(`📊 Shutdown status: ${activeJobs.size} active jobs, ${shutdownCallbacks.length} callbacks`);

  // Set up shutdown timeout
  shutdownTimeout = setTimeout(() => {
    console.error(`❌ Shutdown timeout reached (${SHUTDOWN_TIMEOUT}ms), forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    // Step 1: Save all active job states
    console.log('\n📝 Step 1: Saving active job states...');
    await saveAllActiveJobs();

    // Step 2: Execute shutdown callbacks (stop services, close connections, etc.)
    console.log('\n🔧 Step 2: Executing shutdown callbacks...');
    await executeShutdownCallbacks();

    // Step 3: Close database connections
    console.log('\n💾 Step 3: Closing database connections...');
    // Note: Drizzle with bun:sqlite doesn't require explicit connection closing
    // but we'll add this for completeness and future database changes

    console.log('\n✅ Graceful shutdown completed successfully');

    // Clear the timeout since we completed successfully
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
      shutdownTimeout = null;
    }

    // A shutdown forced by a crash exits non-zero so a supervisor with
    // Restart=on-failure (the Proxmox script's unit) starts the service
    // again; a signal-driven stop is a clean exit (#465).
    process.exit(shutdownExitCode(signal));

  } catch (error) {
    console.error('\n❌ Error during graceful shutdown:', error);

    // Clear the timeout
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
      shutdownTimeout = null;
    }

    // Exit with error code
    process.exit(1);
  }
}

/**
 * Initialize the shutdown manager
 * This should be called early in the application lifecycle
 */
export function initializeShutdownManager(): void {
  console.log('🔧 Initializing shutdown manager...');

  // Reset state in case of re-initialization
  shutdownInProgress = false;
  shutdownStartTime = null;
  activeJobs.clear();
  shutdownCallbacks = []; // Reset callbacks too

  // Clear any existing timeout
  if (shutdownTimeout) {
    clearTimeout(shutdownTimeout);
    shutdownTimeout = null;
  }

  console.log('✅ Shutdown manager initialized');
}

/**
 * Force immediate shutdown (for emergencies)
 */
export function forceShutdown(exitCode: number = 1): void {
  console.error('🚨 Force shutdown requested');

  if (shutdownTimeout) {
    clearTimeout(shutdownTimeout);
  }

  process.exit(exitCode);
}
