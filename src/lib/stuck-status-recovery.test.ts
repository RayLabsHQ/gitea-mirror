/**
 * Tests for stuck in-flight status recovery (issue #339).
 *
 * Repositories interrupted mid-mirror/mid-sync (container restart, OOM,
 * crash) were left stuck at "mirroring"/"syncing" forever: the scheduler's
 * sync pool never selects those statuses, job-level recovery only reconciles
 * mirrorJobs rows (and the scheduler path creates none), and the UI disables
 * the Sync button for in-flight statuses.
 *
 * The decision logic is tested directly as pure functions. The wiring into
 * the scheduler loop, initializeRecovery, and the startup-recovery script is
 * asserted by reading the source (same pattern as
 * gitea-mirror-failure-recovery.test.ts) because behavioral tests of those
 * modules require process-wide module mocks that pollute other test files.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IN_FLIGHT_REPO_STATUSES,
  IN_FLIGHT_ORG_STATUSES,
  STUCK_IN_FLIGHT_THRESHOLD_MS,
  computeStuckStatusCutoff,
  isStuckInFlight,
  buildStuckResetErrorMessage,
  buildStuckResetUpdate,
  resetStuckMirrorStatuses,
} from "./stuck-status-recovery";

const HOUR = 60 * 60 * 1000;

describe("computeStuckStatusCutoff", () => {
  test("uses process start as cutoff while the process is younger than the threshold", () => {
    // Process started 10 minutes ago; now - 2h would reach back BEFORE the
    // process started. The cutoff must clamp to process start so rows written
    // by this process are never considered stuck.
    const processStart = new Date("2026-07-16T10:00:00Z");
    const now = new Date("2026-07-16T10:10:00Z");

    const cutoff = computeStuckStatusCutoff(now, processStart);

    expect(cutoff.getTime()).toBe(processStart.getTime());
  });

  test("uses now - threshold once the process has been up longer than the threshold", () => {
    const processStart = new Date("2026-07-16T00:00:00Z");
    const now = new Date("2026-07-16T10:00:00Z"); // up for 10 hours

    const cutoff = computeStuckStatusCutoff(now, processStart);

    expect(cutoff.getTime()).toBe(now.getTime() - STUCK_IN_FLIGHT_THRESHOLD_MS);
  });

  test("honors a custom threshold", () => {
    const processStart = new Date("2026-07-16T00:00:00Z");
    const now = new Date("2026-07-16T10:00:00Z");

    const cutoff = computeStuckStatusCutoff(now, processStart, 30 * 60 * 1000);

    expect(cutoff.getTime()).toBe(now.getTime() - 30 * 60 * 1000);
  });

  test("threshold matches the 2-hour staleness window from isRepoCurrentlyMirroring", () => {
    expect(STUCK_IN_FLIGHT_THRESHOLD_MS).toBe(2 * HOUR);
  });
});

describe("isStuckInFlight", () => {
  const cutoff = new Date("2026-07-16T08:00:00Z");
  const before = new Date("2026-07-16T05:00:00Z"); // older than cutoff
  const after = new Date("2026-07-16T09:00:00Z"); // newer than cutoff

  test("a 'syncing' repo last updated before the cutoff is stuck", () => {
    expect(isStuckInFlight({ status: "syncing", updatedAt: before }, cutoff)).toBe(true);
  });

  test("a 'mirroring' repo last updated before the cutoff is stuck", () => {
    expect(isStuckInFlight({ status: "mirroring", updatedAt: before }, cutoff)).toBe(true);
  });

  test("an in-flight repo updated after the cutoff is NOT stuck (live work is protected)", () => {
    expect(isStuckInFlight({ status: "syncing", updatedAt: after }, cutoff)).toBe(false);
    expect(isStuckInFlight({ status: "mirroring", updatedAt: after }, cutoff)).toBe(false);
  });

  test("terminal or queued statuses are never stuck, no matter how old", () => {
    for (const status of ["synced", "mirrored", "failed", "imported", "pending-approval", "archived", "ignored"]) {
      expect(isStuckInFlight({ status, updatedAt: before }, cutoff)).toBe(false);
    }
  });

  test("an in-flight repo with no updatedAt is treated as stuck", () => {
    expect(isStuckInFlight({ status: "syncing", updatedAt: null }, cutoff)).toBe(true);
  });

  test("in-flight status lists cover exactly the statuses set before network work", () => {
    // gitea-enhanced.ts sets "syncing"; gitea.ts sets "mirroring" for repos
    // and orgs. Nothing else is written as an intermediate status.
    expect([...IN_FLIGHT_REPO_STATUSES].sort()).toEqual(["mirroring", "syncing"]);
    expect([...IN_FLIGHT_ORG_STATUSES]).toEqual(["mirroring"]);
  });
});

describe("buildStuckResetUpdate / buildStuckResetErrorMessage", () => {
  test("resets to 'failed' with the provided timestamp", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const update = buildStuckResetUpdate("syncing", now);

    expect(update.status).toBe("failed");
    expect(update.updatedAt).toBe(now);
    expect(update.errorMessage.length).toBeGreaterThan(0);
  });

  test("error message names the stuck status and the interrupted operation", () => {
    const syncMessage = buildStuckResetErrorMessage("syncing");
    expect(syncMessage).toContain('"syncing"');
    expect(syncMessage).toContain("interrupted sync");

    const mirrorMessage = buildStuckResetErrorMessage("mirroring");
    expect(mirrorMessage).toContain('"mirroring"');
    expect(mirrorMessage).toContain("interrupted mirror");
  });

  test("error message tells the user how work resumes", () => {
    const message = buildStuckResetErrorMessage("syncing");
    expect(message).toContain("next scheduled run");
    expect(message).toContain("Retry");
  });
});

describe("resetStuckMirrorStatuses", () => {
  test("never throws even when the db layer misbehaves", async () => {
    // The global test setup replaces @/lib/db with a stub whose select chain
    // does not return arrays. The function must swallow that (it runs inside
    // the scheduler loop and recovery — housekeeping must never block them)
    // and report zero resets.
    const result = await resetStuckMirrorStatuses({
      cutoff: new Date(),
      now: new Date(),
    });

    expect(result).toEqual({ repositories: 0, organizations: 0 });
  });
});

describe("wiring (source regression)", () => {
  const read = (...segments: string[]) =>
    readFileSync(join(import.meta.dir, ...segments), "utf8");

  test("scheduler loop resets stuck statuses on every tick, before config filtering", () => {
    const source = read("scheduler-service.ts");

    expect(source).toContain('from \'@/lib/stuck-status-recovery\'');

    const loopStart = source.indexOf("async function schedulerLoop");
    expect(loopStart).toBeGreaterThan(-1);
    const loopBody = source.slice(loopStart);

    const resetCall = loopBody.indexOf("resetStuckMirrorStatuses(");
    const configQuery = loopBody.indexOf("const activeConfigs");
    expect(resetCall).toBeGreaterThan(-1);
    expect(configQuery).toBeGreaterThan(-1);
    // Must run before the enabled-config filtering so stuck rows heal even
    // for users without scheduling enabled.
    expect(resetCall).toBeLessThan(configQuery);
  });

  test("initializeRecovery resets stuck statuses before resuming interrupted jobs", () => {
    const source = read("recovery.ts");

    expect(source).toContain("from './stuck-status-recovery'");

    const initStart = source.indexOf("export async function initializeRecovery");
    expect(initStart).toBeGreaterThan(-1);
    const initBody = source.slice(initStart);

    const resetCall = initBody.indexOf("resetStuckMirrorStatuses(");
    const findJobs = initBody.indexOf("findInterruptedJobs(");
    expect(resetCall).toBeGreaterThan(-1);
    expect(findJobs).toBeGreaterThan(-1);
    expect(resetCall).toBeLessThan(findJobs);
  });

  test("startup-recovery script resets stuck statuses BEFORE the no-jobs early exit", () => {
    const source = read("..", "..", "scripts", "startup-recovery.ts");

    const resetCall = source.indexOf("resetStuckMirrorStatuses(");
    const needsRecoveryCheck = source.indexOf("hasJobsNeedingRecovery()");
    expect(resetCall).toBeGreaterThan(-1);
    expect(needsRecoveryCheck).toBeGreaterThan(-1);
    // Scheduler-driven syncs create no resilient job records, so a crash
    // mid-scheduled-sync leaves stuck repos but NO interrupted jobs. If the
    // reset ran after the early exit it would be skipped in exactly the case
    // that matters (issue #339).
    expect(resetCall).toBeLessThan(needsRecoveryCheck);
  });
});
