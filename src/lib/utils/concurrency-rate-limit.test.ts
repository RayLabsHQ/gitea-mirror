/**
 * processWithRetry and a rate limited source (issue #437, second report).
 * A refusal used to be retried three times with backoff like any other
 * error, and the items behind it were started anyway, so one exhausted
 * budget turned into thousands of 403 responses.
 */

import { describe, expect, test } from "bun:test";
import { RateLimitedBatchError, processWithRetry } from "./concurrency";
import { isRateLimitError } from "@/lib/rate-limit-gate";

function rateLimitRefusal() {
  const error = new Error("API rate limit exceeded for user ID 1.") as Error & { status: number };
  error.status = 403;
  return error;
}

describe("processWithRetry under a rate limit", () => {
  test("a rate limit refusal is not retried and the remaining items are not started", async () => {
    const attempts: number[] = [];
    let caught: unknown;
    try {
      await processWithRetry(
        [1, 2, 3, 4, 5, 6],
        async (n) => {
          attempts.push(n);
          if (n === 2) throw rateLimitRefusal();
          return n * 10;
        },
        { concurrencyLimit: 2, maxRetries: 3, retryDelay: 1 }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RateLimitedBatchError);
    const failure = caught as RateLimitedBatchError<number>;
    // Item 2 was attempted exactly once; items 3 to 6 never started. The two
    // items of the first batch run concurrently, so their order is not fixed.
    expect([...attempts].sort()).toEqual([1, 2]);
    expect(failure.results).toEqual([10]);
    expect(failure.message).toContain("5 item(s) left");
    expect(failure.status).toBe(403);
    // Callers up the stack classify it like the refusal that caused it.
    expect(isRateLimitError(failure)).toBe(true);
    expect(isRateLimitError(failure.cause)).toBe(true);
  });

  test("a 429 from a paginated call counts as a rate limit too", async () => {
    const attempts: number[] = [];
    const tooMany = Object.assign(new Error("Too many requests"), { status: 429 });
    await expect(
      processWithRetry(
        [1, 2, 3],
        async (n) => {
          attempts.push(n);
          if (n === 1) throw tooMany;
          return n;
        },
        { concurrencyLimit: 1, maxRetries: 3, retryDelay: 1 }
      )
    ).rejects.toBeInstanceOf(RateLimitedBatchError);
    expect(attempts).toEqual([1]);
  });

  test("other errors keep their retries and do not stop the batch", async () => {
    const attempts: number[] = [];
    const results = await processWithRetry(
      [1, 2, 3],
      async (n) => {
        attempts.push(n);
        if (n === 2 && attempts.filter((a) => a === 2).length < 3) {
          throw new Error("Gitea hiccup");
        }
        return n;
      },
      { concurrencyLimit: 1, maxRetries: 3, retryDelay: 1 }
    );
    expect(results).toEqual([1, 2, 3]);
    expect(attempts).toEqual([1, 2, 2, 2, 3]);
  });

  test("a batch that finishes without a refusal returns every result as before", async () => {
    const results = await processWithRetry([1, 2, 3], async (n) => n + 1, {
      concurrencyLimit: 3,
      maxRetries: 0,
      retryDelay: 1,
    });
    expect(results).toEqual([2, 3, 4]);
  });
});
