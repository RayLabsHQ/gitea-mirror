/**
 * The GitHub clients built by github.ts hold their requests while the gate
 * is closed, and the secondary limit handler closes the gate for everyone
 * (issue #437, second report). Uses a fake global fetch so nothing leaves
 * the process; the point of these tests is that nothing does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createGitHubClient,
  createPublicGitHubClient,
  githubThrottleOptions,
} from "@/lib/github";
import {
  RateLimitPausedError,
  clearAllRateLimits,
  isRateLimitError,
  markRateLimited,
  rateLimitGateKey,
  rateLimitedUntil,
} from "@/lib/rate-limit-gate";

const realFetch = globalThis.fetch;

describe("GitHub clients while the gate is closed", () => {
  let sent: string[] = [];

  beforeEach(() => {
    clearAllRateLimits();
    sent = [];
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      sent.push(url);
      return new Response(JSON.stringify({ resources: {}, rate: { remaining: 1 } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
        },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearAllRateLimits();
  });

  test("an authenticated client sends nothing during a long pause and fails with the paused error", async () => {
    const octokit = createGitHubClient("ghp_test", "user-1");
    markRateLimited(rateLimitGateKey("user-1"), Date.now() + 3_263_000);

    let caught: unknown;
    try {
      await octokit.rest.repos.get({ owner: "a", repo: "b" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RateLimitPausedError);
    expect(isRateLimitError(caught)).toBe(true);
    expect(sent).toEqual([]);
  });

  test("paginate stops at the gate too, before the first page", async () => {
    const octokit = createGitHubClient("ghp_test", "user-2");
    markRateLimited(rateLimitGateKey("user-2"), Date.now() + 3_600_000);

    await expect(
      octokit.paginate(octokit.rest.issues.listForRepo, { owner: "a", repo: "b", per_page: 100 })
    ).rejects.toBeInstanceOf(RateLimitPausedError);
    expect(sent).toEqual([]);
  });

  test("the rate limit probe still goes out, so the pause can be confirmed or lifted", async () => {
    const octokit = createGitHubClient("ghp_test", "user-3");
    markRateLimited(rateLimitGateKey("user-3"), Date.now() + 3_600_000);

    await octokit.rest.rateLimit.get();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("/rate_limit");
    // The probe answered with budget left, which opens the gate again.
    expect(rateLimitedUntil(rateLimitGateKey("user-3"))).toBeNull();
    await octokit.rest.repos.get({ owner: "a", repo: "b" });
    expect(sent).toHaveLength(2);
  });

  test("another user's pause does not hold this user's client", async () => {
    const octokit = createGitHubClient("ghp_test", "user-4");
    markRateLimited(rateLimitGateKey("user-5"), Date.now() + 3_600_000);

    await octokit.rest.repos.get({ owner: "a", repo: "b" });
    expect(sent).toHaveLength(1);
  });

  test("tokenless clients share the anonymous gate", async () => {
    const octokit = createPublicGitHubClient();
    markRateLimited(rateLimitGateKey(undefined), Date.now() + 3_600_000);

    await expect(octokit.rest.repos.get({ owner: "a", repo: "b" })).rejects.toBeInstanceOf(
      RateLimitPausedError
    );
    expect(sent).toEqual([]);
  });
});

describe("secondary rate limit handler", () => {
  beforeEach(() => {
    clearAllRateLimits();
  });

  test("closes the gate for the retry-after window and still retries the request itself", async () => {
    const before = Date.now();
    const options = githubThrottleOptions("user-secondary");
    const retry = await options.onSecondaryRateLimit(
      60,
      { method: "GET", url: "/repos/a/b/issues" },
      {},
      0
    );
    expect(retry).toBe(true);

    const until = rateLimitedUntil(rateLimitGateKey("user-secondary"));
    expect(until).not.toBeNull();
    const pausedFor = until!.getTime() - before;
    expect(pausedFor).toBeGreaterThanOrEqual(59_000);
    expect(pausedFor).toBeLessThanOrEqual(61_000);
  });

  test("gives up after two retries but the gate stays closed for the window", async () => {
    const options = githubThrottleOptions("user-secondary-2");
    expect(await options.onSecondaryRateLimit(30, { method: "GET", url: "/x" }, {}, 2)).toBe(false);
    expect(rateLimitedUntil(rateLimitGateKey("user-secondary-2"))).not.toBeNull();
  });

  test("a tokenless client records the pause under the anonymous key", async () => {
    const options = githubThrottleOptions();
    await options.onSecondaryRateLimit(10, { method: "GET", url: "/x" }, {}, 0);
    expect(rateLimitedUntil(rateLimitGateKey(undefined))).not.toBeNull();
  });
});
