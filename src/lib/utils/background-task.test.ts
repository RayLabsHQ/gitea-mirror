/**
 * Background work started by the job routes (#557). A manual sync that hit
 * GitHub's rate limit threw RateLimitedBatchError out of a setTimeout
 * callback nobody awaited, and the unhandled rejection shut the server down.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RateLimitedBatchError, processWithRetry } from "./concurrency";
import { runBackgroundTask } from "./background-task";

function rateLimitRefusal() {
  const error = new Error("API rate limit exceeded for user ID 1.") as Error & { status: number };
  error.status = 403;
  return error;
}

describe("runBackgroundTask", () => {
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    error = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  test("a batch stopped by the rate limit does not escape", async () => {
    // The same path the routes take: processWithRetry stops the batch and
    // throws RateLimitedBatchError.
    const task = () =>
      processWithRetry(
        [1, 2, 3],
        async (n) => {
          if (n === 1) throw rateLimitRefusal();
          return n;
        },
        { concurrencyLimit: 1, maxRetries: 2, retryDelay: 1 }
      );

    await expect(task()).rejects.toBeInstanceOf(RateLimitedBatchError);
    warn.mockClear();
    error.mockClear();

    await expect(runBackgroundTask("Sync", task)).resolves.toBeUndefined();

    const firstArgs = (calls: unknown[][]) => calls.map((args) => String(args[0]));
    expect(
      firstArgs(warn.mock.calls).some((line) => line.startsWith("[Sync] Stopped by the source rate limit"))
    ).toBe(true);
    expect(firstArgs(error.mock.calls).some((line) => line.startsWith("[Sync]"))).toBe(false);
  });

  test("any other failure does not escape either, and is logged as an error", async () => {
    const failure = new Error("Destination token is missing in config.");

    await expect(
      runBackgroundTask("Org mirror", async () => {
        throw failure;
      })
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith("[Org mirror] Background job failed:", failure);
  });

  test("a task that finishes logs nothing", async () => {
    let ran = false;
    await runBackgroundTask("Mirror", async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("API routes", () => {
  test("no route starts background work in a bare setTimeout callback", () => {
    // A bare `setTimeout(async () => ...)` has no one to catch what it
    // throws. Routes go through runInBackground instead.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          if (/setTimeout\(\s*async\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
        }
      }
    };
    walk(join(import.meta.dir, "../../pages/api"));

    expect(offenders).toEqual([]);
  });
});
