/**
 * Regression test for the "interrupted jobs never resume after
 * startup" orchestration bug.
 *
 * Symptom (before this fix):
 *   - Server starts cleanly. Middleware runs initial recovery pass,
 *     finds no interrupted jobs, sets `recoveryAttempted = true` and
 *     `recoveryInitialized = true`.
 *   - User triggers a sync at T=N (well after startup). The sync
 *     creates a `mirrorJobs` row with `inProgress=true`.
 *   - The sync fails mid-flight (deadlock retry, network blip,
 *     container restart of an upstream service, etc.) and never
 *     reaches the resume codepath, so the row stays
 *     `inProgress=true` with no checkpoint.
 *   - `findInterruptedJobs` (called periodically from the health
 *     endpoint via `hasJobsNeedingRecovery`) detects it and logs
 *     `Found 1 interrupted jobs:` on every poll.
 *   - But the resumer (`resumeInterruptedJob`) is only invoked from
 *     `initializeRecovery`, which is gated behind the
 *     once-per-process `!recoveryAttempted` check in
 *     `src/middleware.ts`. That check is false after startup, so the
 *     resumer NEVER fires again. The job is stuck forever.
 *
 * Root cause: the middleware gate was symmetric — "skip recovery if
 * we've ever attempted it" — but it should have been "always
 * re-evaluate; only the recovery routine's own 5-minute throttle
 * (`skipIfRecentAttempt` inside `initializeRecovery`) prevents
 * thrashing".
 *
 * Secondary issue: `findInterruptedJobs` logged unconditionally on
 * every call, even from passive checks like `hasJobsNeedingRecovery`,
 * producing log spam at one line per poll per stuck job.
 *
 * This test asserts on the *structure* of the source rather than
 * invoking the middleware, because exercising the middleware path
 * requires a full Astro request pipeline with heavy mocks. See
 * `gitea-mirror-failure-recovery.test.ts` and
 * `gitea-issue-dedup-on-retry.test.ts` for the same convention.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIDDLEWARE_SRC = readFileSync(
  join(import.meta.dir, "../middleware.ts"),
  "utf8"
);
const HELPERS_SRC = readFileSync(
  join(import.meta.dir, "helpers.ts"),
  "utf8"
);
const RECOVERY_SRC = readFileSync(
  join(import.meta.dir, "recovery.ts"),
  "utf8"
);

describe("orchestrator: resume interrupted jobs after startup", () => {
  test("middleware no longer gates recovery behind once-per-process `recoveryAttempted`", () => {
    // The old gate looked like:
    //   if (!recoveryInitialized && !recoveryAttempted) {
    //     recoveryAttempted = true;
    //     ...
    //   }
    // Once both flags flipped on the first request, recovery never
    // ran again — even if jobs got stuck mid-runtime.
    expect(
      /\brecoveryAttempted\b/.test(MIDDLEWARE_SRC),
      "the `recoveryAttempted` once-per-process flag must be removed " +
        "from middleware.ts so post-startup interruptions can recover"
    ).toBe(false);
  });

  test("middleware uses an in-flight latch (not a one-shot gate) for runtime safety", () => {
    // The replacement uses `recoveryInFlight` as a per-request
    // mutex — set true at the start, set false in `finally`. The
    // actual throttle (5-minute "recent attempt") lives inside
    // `initializeRecovery()` in recovery.ts, which is the right
    // place for it.
    expect(
      /\brecoveryInFlight\b/.test(MIDDLEWARE_SRC),
      "middleware should use `recoveryInFlight` as the in-flight latch"
    ).toBe(true);
    expect(
      /recoveryInFlight\s*=\s*false/.test(MIDDLEWARE_SRC) &&
        /\bfinally\s*\{[\s\S]*?recoveryInFlight\s*=\s*false[\s\S]*?\}/.test(
          MIDDLEWARE_SRC
        ),
      "the in-flight latch must be released in a `finally` block " +
        "so an exception during recovery doesn't permanently jam the latch"
    ).toBe(true);
  });

  test("findInterruptedJobs logging is opt-in (default off) to stop poll spam", () => {
    // Active recovery callers (initializeRecovery) opt in by passing
    // { logFound: true }; passive checks (hasJobsNeedingRecovery,
    // health endpoint, etc.) default to silent.
    expect(
      /export async function findInterruptedJobs\(\s*options[^)]*\)/.test(
        HELPERS_SRC
      ),
      "findInterruptedJobs should accept an options object"
    ).toBe(true);
    expect(
      /logFound\s*=\s*false/.test(HELPERS_SRC),
      "the `logFound` option should default to false " +
        "so periodic passive checks (e.g. hasJobsNeedingRecovery) " +
        "don't spam the log on every poll"
    ).toBe(true);
    expect(
      /if\s*\(\s*logFound\s*&&\s*interruptedJobs\.length\s*>\s*0\s*\)/.test(
        HELPERS_SRC
      ),
      "the `Found N interrupted jobs` log must be gated by `logFound`"
    ).toBe(true);
  });

  test("active recovery path opts in to per-job logging", () => {
    // Without this, the actual recovery cycle would also be silent
    // — operators need to see which jobs are being resumed.
    expect(
      /findInterruptedJobs\(\s*\{\s*logFound:\s*true\s*\}\s*\)/.test(
        RECOVERY_SRC
      ),
      "initializeRecovery() must pass { logFound: true } to findInterruptedJobs " +
        "so the active recovery cycle still logs which jobs it's working on"
    ).toBe(true);
  });
});
