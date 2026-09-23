/**
 * The request wrap that holds every GitHub call while the gate is closed
 * (issue #437, second report). Tested against a hand made hook so the
 * clock and the sleep are under control.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  RateLimitPausedError,
  clearAllRateLimits,
  installRateLimitGate,
  isRateLimitError,
  markRateLimited,
} from "@/lib/rate-limit-gate";

type Wrapper = (request: (o: any) => Promise<any>, options: any) => Promise<any>;

function fakeOctokit() {
  const holder: { wrapper?: Wrapper } = {};
  return {
    holder,
    octokit: {
      hook: {
        wrap: (_name: string, wrapper: Wrapper) => {
          holder.wrapper = wrapper;
        },
      },
    },
  };
}

describe("installRateLimitGate", () => {
  const key = "user-gate";
  const base = new Date("2026-09-24T10:00:00.000Z");

  beforeEach(() => {
    clearAllRateLimits();
  });

  test("an open gate passes the request straight through", async () => {
    const { octokit, holder } = fakeOctokit();
    const sleeps: number[] = [];
    installRateLimitGate(octokit, { key, maxWaitMs: 120_000, sleep: async (ms) => void sleeps.push(ms), now: () => base });

    const sent: any[] = [];
    const result = await holder.wrapper!(async (o) => { sent.push(o); return "ok"; }, { method: "GET", url: "/repos/a/b" });
    expect(result).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("a long pause fails the request without calling the inner request", async () => {
    const { octokit, holder } = fakeOctokit();
    installRateLimitGate(octokit, { key, maxWaitMs: 120_000, sleep: async () => {}, now: () => base });
    markRateLimited(key, base.getTime() + 3_263_000);

    let inner = 0;
    let caught: unknown;
    try {
      await holder.wrapper!(async () => { inner += 1; return "no"; }, { method: "GET", url: "/repos/a/b/issues" });
    } catch (error) {
      caught = error;
    }
    expect(inner).toBe(0);
    expect(caught).toBeInstanceOf(RateLimitPausedError);
    expect((caught as RateLimitPausedError).status).toBe(403);
    expect((caught as RateLimitPausedError).message).toContain("paused until 2026-09-24T10:54:23.000Z");
    expect((caught as RateLimitPausedError).message).toContain("GET /repos/a/b/issues");
    // The rest of the code base classifies it like GitHub's own refusal.
    expect(isRateLimitError(caught)).toBe(true);
  });

  test("a short pause is slept off with a one second cushion, then the request goes out", async () => {
    const { octokit, holder } = fakeOctokit();
    const sleeps: number[] = [];
    installRateLimitGate(octokit, { key, maxWaitMs: 120_000, sleep: async (ms) => void sleeps.push(ms), now: () => base });
    markRateLimited(key, base.getTime() + 45_000);

    let inner = 0;
    const result = await holder.wrapper!(async () => { inner += 1; return "sent"; }, { method: "GET", url: "/repos/a/b" });
    expect(result).toBe("sent");
    expect(inner).toBe(1);
    expect(sleeps).toEqual([46_000]);
  });

  test("exactly the threshold still waits; one millisecond more fails", async () => {
    const { octokit, holder } = fakeOctokit();
    const sleeps: number[] = [];
    installRateLimitGate(octokit, { key, maxWaitMs: 120_000, sleep: async (ms) => void sleeps.push(ms), now: () => base });

    markRateLimited(key, base.getTime() + 120_000);
    await holder.wrapper!(async () => "a", { method: "GET", url: "/x" });
    expect(sleeps).toEqual([121_000]);

    clearAllRateLimits();
    markRateLimited(key, base.getTime() + 120_001);
    await expect(holder.wrapper!(async () => "b", { method: "GET", url: "/x" })).rejects.toBeInstanceOf(RateLimitPausedError);
  });

  test("the rate limit probe is exempt so the pause can be checked", async () => {
    const { octokit, holder } = fakeOctokit();
    installRateLimitGate(octokit, { key, maxWaitMs: 120_000, sleep: async () => {}, now: () => base });
    markRateLimited(key, base.getTime() + 3_600_000);

    let inner = 0;
    await holder.wrapper!(async () => { inner += 1; return "probe"; }, { method: "GET", url: "/rate_limit" });
    expect(inner).toBe(1);
    await expect(holder.wrapper!(async () => "no", { method: "GET", url: "/rate_limited_looking/but/not" })).rejects.toBeInstanceOf(RateLimitPausedError);
  });

  test("keys are independent: another user's pause does not hold this client", async () => {
    const { octokit, holder } = fakeOctokit();
    installRateLimitGate(octokit, { key, maxWaitMs: 120_000, sleep: async () => {}, now: () => base });
    markRateLimited("someone-else", base.getTime() + 3_600_000);

    let inner = 0;
    await holder.wrapper!(async () => { inner += 1; return "ok"; }, { method: "GET", url: "/repos/a/b" });
    expect(inner).toBe(1);
  });

  test("a client without a hook system is left alone", () => {
    expect(() => installRateLimitGate({}, { key, maxWaitMs: 1 })).not.toThrow();
    expect(() => installRateLimitGate(undefined, { key, maxWaitMs: 1 })).not.toThrow();
  });
});
