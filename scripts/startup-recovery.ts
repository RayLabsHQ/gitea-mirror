#!/usr/bin/env bun
/**
 * Startup recovery script
 * This script runs job recovery before the application starts serving requests
 * It ensures that any interrupted jobs from previous runs are properly handled
 *
 * Usage:
 *   bun scripts/startup-recovery.ts [--force] [--timeout=30000]
 *
 * Options:
 *   --force: Force recovery even if a recent attempt was made
 *   --timeout: Maximum time to wait for recovery (in milliseconds, default: 30000)
 */

import { initializeRecovery, hasJobsNeedingRecovery, getRecoveryStatus } from "../src/lib/recovery";
import { resetStuckMirrorStatuses } from "../src/lib/stuck-status-recovery";

// Parse command line arguments
const args = process.argv.slice(2);
const forceRecovery = args.includes('--force');
const timeoutArg = args.find(arg => arg.startsWith('--timeout='));
const timeout = timeoutArg ? parseInt(timeoutArg.split('=')[1], 10) : 30000;

if (isNaN(timeout) || timeout < 1000) {
  console.error("Error: Timeout must be at least 1000ms");
  process.exit(1);
}

async function runStartupRecovery() {
  console.log('=== Gitea Mirror Startup Recovery ===');
  console.log(`Timeout: ${timeout}ms`);
  console.log(`Force recovery: ${forceRecovery}`);
  console.log('');

  const startTime = Date.now();

  try {
    // Set up timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Recovery timeout after ${timeout}ms`));
      }, timeout);
    });

    // Reset repositories/organizations stuck in an in-flight status
    // ("mirroring"/"syncing") from a previous run (issue #339). This must
    // happen BEFORE the needsRecovery early-exit below: scheduler-driven
    // syncs create no resilient job records, so a crash mid-scheduled-sync
    // leaves stuck repo rows but NO interrupted jobs — the early exit would
    // skip them forever. The app is not running while this script executes,
    // so every in-flight row is an orphan by definition (this script's own
    // process start is the cutoff). Never throws.
    console.log('Checking for repositories stuck in an in-flight status...');
    const stuckReset = await resetStuckMirrorStatuses();
    if (stuckReset.repositories > 0 || stuckReset.organizations > 0) {
      console.log(
        `✅ Reset ${stuckReset.repositories} stuck repositor${stuckReset.repositories === 1 ? 'y' : 'ies'} ` +
        `and ${stuckReset.organizations} stuck organization(s) to "failed" for retry.`
      );
    } else {
      console.log('✅ No stuck repository/organization statuses found.');
    }

    // Check if recovery is needed first
    console.log('Checking if recovery is needed...');
    const needsRecovery = await hasJobsNeedingRecovery();

    if (!needsRecovery) {
      console.log('✅ No jobs need recovery. Startup can proceed.');
      process.exit(0);
    }

    console.log('⚠️  Jobs found that need recovery. Starting recovery process...');

    // Run recovery with timeout
    const recoveryPromise = initializeRecovery({
      skipIfRecentAttempt: !forceRecovery,
      maxRetries: 3,
      retryDelay: 5000,
    });

    const recoveryResult = await Promise.race([recoveryPromise, timeoutPromise]);

    const endTime = Date.now();
    const duration = endTime - startTime;

    if (recoveryResult) {
      console.log(`✅ Recovery completed successfully in ${duration}ms`);
      console.log('Application startup can proceed.');
      process.exit(0);
    } else {
      console.log(`⚠️  Recovery completed with some failures in ${duration}ms`);
      console.log('Application startup can proceed, but some jobs may have failed.');
      process.exit(0);
    }

  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;

    if (error instanceof Error && error.message.includes('timeout')) {
      console.error(`❌ Recovery timed out after ${duration}ms`);
      console.error('Application will start anyway, but some jobs may remain interrupted.');
      
      // Get current recovery status
      const status = getRecoveryStatus();
      console.log('Recovery status:', status);
      
      // Exit with warning code but allow startup to continue
      process.exit(1);
    } else {
      console.error(`❌ Recovery failed after ${duration}ms:`, error);
      console.error('Application will start anyway, but recovery was unsuccessful.');
      
      // Exit with error code but allow startup to continue
      process.exit(1);
    }
  }
}

// Handle process signals gracefully
process.on('SIGINT', () => {
  console.log('\n⚠️  Recovery interrupted by SIGINT');
  process.exit(130);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️  Recovery interrupted by SIGTERM');
  process.exit(143);
});

// Run the startup recovery
runStartupRecovery();
