import { describe, expect, test, beforeEach } from "bun:test";
import {
  TOKENLESS_RATE_LIMIT_KEY,
  clearAllRateLimits,
  clearRateLimit,
  isRateLimitError,
  markRateLimited,
  rateLimitGateKey,
  rateLimitedUntil,
} from "@/lib/rate-limit-gate";

describe("rate limit gate keys", () => {
  beforeEach(() => {
    clearAllRateLimits();
  });

  test("a user id is its own key and an empty one falls back to the tokenless key", () => {
    expect(rateLimitGateKey("user-1")).toBe("user-1");
    expect(rateLimitGateKey("  user-2  ")).toBe("user-2");
    expect(rateLimitGateKey("")).toBe(TOKENLESS_RATE_LIMIT_KEY);
    expect(rateLimitGateKey("   ")).toBe(TOKENLESS_RATE_LIMIT_KEY);
    expect(rateLimitGateKey(undefined)).toBe(TOKENLESS_RATE_LIMIT_KEY);
    expect(rateLimitGateKey(null)).toBe(TOKENLESS_RATE_LIMIT_KEY);
  });

  test("keys do not interfere with each other", () => {
    const resetAt = new Date(Date.now() + 600_000);
    markRateLimited("user-1", resetAt);

    expect(rateLimitedUntil("user-1")?.getTime()).toBe(resetAt.getTime());
    expect(rateLimitedUntil("user-2")).toBeNull();
    expect(rateLimitedUntil(TOKENLESS_RATE_LIMIT_KEY)).toBeNull();
  });
});

describe("rate limit gate state", () => {
  beforeEach(() => {
    clearAllRateLimits();
  });

  test("an unknown key is not limited", () => {
    expect(rateLimitedUntil("user-1")).toBeNull();
  });

  test("a recorded reset is reported until it passes, then forgotten", () => {
    const now = new Date("2026-01-01T09:00:00.000Z");
    const resetAt = new Date("2026-01-01T09:30:00.000Z");
    markRateLimited("user-1", resetAt);

    expect(rateLimitedUntil("user-1", now)?.toISOString()).toBe(resetAt.toISOString());

    const afterReset = new Date("2026-01-01T09:30:00.001Z");
    expect(rateLimitedUntil("user-1", afterReset)).toBeNull();
    // Reading past the reset drops the entry, so the gate opens on its own.
    expect(rateLimitedUntil("user-1", now)).toBeNull();
  });

  test("a reset exactly at the current time is already over", () => {
    const now = new Date("2026-01-01T09:00:00.000Z");
    markRateLimited("user-1", now);

    expect(rateLimitedUntil("user-1", now)).toBeNull();
  });

  test("the furthest reset wins", () => {
    const now = new Date("2026-01-01T09:00:00.000Z");
    const nearer = new Date("2026-01-01T09:10:00.000Z");
    const further = new Date("2026-01-01T09:45:00.000Z");

    markRateLimited("user-1", nearer);
    markRateLimited("user-1", further);
    expect(rateLimitedUntil("user-1", now)?.toISOString()).toBe(further.toISOString());

    // A later call reporting a nearer reset must not shorten the pause.
    markRateLimited("user-1", nearer);
    expect(rateLimitedUntil("user-1", now)?.toISOString()).toBe(further.toISOString());
  });

  test("epoch milliseconds are accepted and nonsense is ignored", () => {
    const now = new Date("2026-01-01T09:00:00.000Z");
    const resetAt = new Date("2026-01-01T09:20:00.000Z");

    markRateLimited("user-1", resetAt.getTime());
    expect(rateLimitedUntil("user-1", now)?.toISOString()).toBe(resetAt.toISOString());

    markRateLimited("user-2", Number.NaN);
    markRateLimited("user-3", new Date("not a date"));
    expect(rateLimitedUntil("user-2", now)).toBeNull();
    expect(rateLimitedUntil("user-3", now)).toBeNull();
  });

  test("clearRateLimit opens one key and clearAllRateLimits opens every key", () => {
    const resetAt = new Date(Date.now() + 600_000);
    markRateLimited("user-1", resetAt);
    markRateLimited("user-2", resetAt);

    clearRateLimit("user-1");
    expect(rateLimitedUntil("user-1")).toBeNull();
    expect(rateLimitedUntil("user-2")).not.toBeNull();

    clearAllRateLimits();
    expect(rateLimitedUntil("user-2")).toBeNull();
  });
});

describe("isRateLimitError", () => {
  test("recognises Octokit's primary rate limit refusal", () => {
    const error = Object.assign(
      new Error("API rate limit exceeded for user ID 1234."),
      { status: 403 }
    );
    expect(isRateLimitError(error)).toBe(true);
  });

  test("recognises the secondary rate limit and 429", () => {
    const secondary = Object.assign(
      new Error("You have exceeded a secondary rate limit."),
      { status: 403 }
    );
    expect(isRateLimitError(secondary)).toBe(true);

    const tooManyRequests = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(isRateLimitError(tooManyRequests)).toBe(true);
  });

  test("reads the status off a nested response when the error does not carry one", () => {
    const error = Object.assign(new Error("Too Many Requests"), {
      response: { status: 429 },
    });
    expect(isRateLimitError(error)).toBe(true);
  });

  test("recognises a rate limit that was re-thrown with only its message", () => {
    // gitea.ts wraps mirror failures in a plain Error, so no status survives
    // to the scheduler.
    const wrapped = new Error(
      "Failed to mirror repository: API rate limit exceeded for user ID 1234."
    );
    expect(isRateLimitError(wrapped)).toBe(true);
  });

  test("ignores everything else", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError(new Error("Repository not found in Gitea"))).toBe(false);
    expect(
      isRateLimitError(Object.assign(new Error("Bad credentials"), { status: 401 }))
    ).toBe(false);
    // A 404 body that happens to mention the phrase is not a refusal to serve.
    expect(
      isRateLimitError(
        Object.assign(new Error("see the rate limit documentation"), { status: 404 })
      )
    ).toBe(false);
  });
});
