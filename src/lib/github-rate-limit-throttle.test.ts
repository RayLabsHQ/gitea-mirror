import { describe, expect, test } from "bun:test";
import {
  RATE_LIMIT_FAST_FAIL_THRESHOLD_SECONDS,
  decideRateLimitRetry,
} from "@/lib/github";

// The decision the Octokit throttling plugin's onRateLimit handler makes,
// pulled out of the handler so the policy can be checked without a client.
describe("decideRateLimitRetry", () => {
  const maxRetries = 3;

  test("short waits are still retried inside the request", () => {
    expect(decideRateLimitRetry({ retryAfter: 5, retryCount: 0, maxRetries })).toBe("retry");
    expect(decideRateLimitRetry({ retryAfter: 60, retryCount: 2, maxRetries })).toBe("retry");
    expect(
      decideRateLimitRetry({
        retryAfter: RATE_LIMIT_FAST_FAIL_THRESHOLD_SECONDS,
        retryCount: 0,
        maxRetries,
      })
    ).toBe("retry");
  });

  test("short waits stop once the retries are used up", () => {
    expect(decideRateLimitRetry({ retryAfter: 30, retryCount: 3, maxRetries })).toBe("give-up");
    expect(decideRateLimitRetry({ retryAfter: 30, retryCount: 9, maxRetries })).toBe("give-up");
  });

  test("a wait past the threshold fails fast on the first hit, whatever the retry count", () => {
    // The reporter's log showed a 3263s wait, which used to be slept off
    // inside the scheduler lock three times over (issue #437).
    expect(decideRateLimitRetry({ retryAfter: 3263, retryCount: 0, maxRetries })).toBe("fail-fast");
    expect(decideRateLimitRetry({ retryAfter: 3263, retryCount: 2, maxRetries })).toBe("fail-fast");
    expect(
      decideRateLimitRetry({
        retryAfter: RATE_LIMIT_FAST_FAIL_THRESHOLD_SECONDS + 1,
        retryCount: 0,
        maxRetries,
      })
    ).toBe("fail-fast");
  });

  test("search endpoints get their extra retries for short waits only", () => {
    const searchRetries = 5;
    expect(decideRateLimitRetry({ retryAfter: 10, retryCount: 4, maxRetries: searchRetries })).toBe("retry");
    expect(decideRateLimitRetry({ retryAfter: 10, retryCount: 5, maxRetries: searchRetries })).toBe("give-up");
    expect(decideRateLimitRetry({ retryAfter: 900, retryCount: 0, maxRetries: searchRetries })).toBe("fail-fast");
  });

  test("the threshold is configurable for callers that want a different budget", () => {
    expect(
      decideRateLimitRetry({ retryAfter: 45, retryCount: 0, maxRetries, thresholdSeconds: 30 })
    ).toBe("fail-fast");
    expect(
      decideRateLimitRetry({ retryAfter: 45, retryCount: 0, maxRetries, thresholdSeconds: 600 })
    ).toBe("retry");
  });

  test("the default threshold keeps waits to two minutes", () => {
    expect(RATE_LIMIT_FAST_FAIL_THRESHOLD_SECONDS).toBe(120);
  });
});
