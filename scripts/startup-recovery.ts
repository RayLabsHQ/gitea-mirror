#!/usr/bin/env bun
/**
 * Startup recovery script, run by the Docker entrypoint and the Nix service
 * before the server starts.
 *
 * It resets repositories and organizations left in "mirroring" or "syncing"
 * by the previous process, and reports interrupted jobs. It does not resume
 * them: the server does that as soon as it starts, because a job last
 * touched before the server's process started counts as interrupted at once
 * (#564). This script used to resume them in its own short-lived process,
 * which exited after its timeout and left the job marked as running with a
 * fresh checkpoint, so the server only picked it up 10 minutes later.
 *
 * Usage:
 *   bun scripts/startup-recovery.ts
 *
 * --force and --timeout=<ms> are still accepted, so existing entrypoints keep
 * working, but no longer change anything.
 */

import { hasJobsNeedingRecovery } from "../src/lib/recovery";
import { findInterruptedJobs } from "../src/lib/helpers";
import { resetStuckMirrorStatuses } from "../src/lib/stuck-status-recovery";

async function runStartupRecovery() {
  console.log('=== Gitea Mirror Startup Recovery ===');

  try {
    // Reset repositories/organizations stuck in an in-flight status
    // ("mirroring"/"syncing") from a previous run (issue #339). Scheduler
    // driven syncs create no resilient job records, so a crash mid-sync can
    // leave stuck rows without any interrupted job. The app is not running
    // while this script executes, so every in-flight row is an orphan by
    // definition (this script's own process start is the cutoff). Never
    // throws.
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

    if (!(await hasJobsNeedingRecovery())) {
      console.log('✅ No interrupted jobs. Startup can proceed.');
      process.exit(0);
    }

    const jobs = await findInterruptedJobs({ logFound: true });
    console.log(
      `ℹ️  ${jobs.length} interrupted job(s) will be resumed by the server as soon as it starts.`
    );
    process.exit(0);
  } catch (error) {
    console.error('❌ Startup recovery check failed:', error);
    console.error('Application will start anyway; the server checks for interrupted jobs itself.');
    process.exit(1);
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

runStartupRecovery();
