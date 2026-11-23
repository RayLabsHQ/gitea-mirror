/**
 * The latest release lookup behind /api/health. The Docker health check
 * calls the route every few seconds, so a failed GitHub call must be cached
 * too, or the anonymous rate limit keeps it failing.
 *
 * The route imports the recovery module, whose helpers the preload replaces
 * with a partial mock, so this file mocks it and runs in its own process.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runsIsolated } from "@/tests/isolated";

const isolated = runsIsolated(import.meta.path);

if (isolated) {
  mock.module("@/lib/recovery", () => ({
    getRecoveryStatus: () => ({ inProgress: false, lastAttempt: null }),
    hasJobsNeedingRecovery: async () => false,
  }));
}

const health = isolated ? await import("./health") : null;

const MINUTE = 60 * 1000;

const originalFetch = globalThis.fetch;
let clock = 0;
let calls: string[] = [];
let respond: () => Response;

function release(tag: string): Response {
  return new Response(JSON.stringify({ tag_name: tag }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rateLimited(): Response {
  return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403,
    statusText: "Forbidden",
    headers: { "content-type": "application/json" },
  });
}

describe.skipIf(!isolated)("checkLatestVersion", () => {
  let nowSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    health!.resetVersionCache();
    clock = Date.UTC(2026, 0, 1);
    nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    calls = [];
    respond = () => release("v9.9.9");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return respond();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    nowSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("caches a successful lookup for an hour", async () => {
    expect(await health!.checkLatestVersion()).toBe("9.9.9");
    clock += 59 * MINUTE;
    expect(await health!.checkLatestVersion()).toBe("9.9.9");
    expect(calls).toEqual(["https://api.github.com/repos/RayLabsHQ/gitea-mirror/releases/latest"]);

    clock += 2 * MINUTE;
    await health!.checkLatestVersion();
    expect(calls).toHaveLength(2);
  });

  test("caches a failed lookup instead of retrying on every call", async () => {
    respond = rateLimited;
    expect(await health!.checkLatestVersion()).toBe("unknown");
    expect(await health!.checkLatestVersion()).toBe("unknown");
    clock += 14 * MINUTE;
    expect(await health!.checkLatestVersion()).toBe("unknown");
    expect(calls).toHaveLength(1);

    respond = () => release("v9.9.10");
    clock += 2 * MINUTE;
    expect(await health!.checkLatestVersion()).toBe("9.9.10");
    expect(calls).toHaveLength(2);
  });

  test("keeps the last known version when a refresh fails", async () => {
    expect(await health!.checkLatestVersion()).toBe("9.9.9");
    respond = rateLimited;
    clock += 2 * 60 * MINUTE;
    expect(await health!.checkLatestVersion()).toBe("9.9.9");
    expect(await health!.checkLatestVersion()).toBe("9.9.9");
    expect(calls).toHaveLength(2);
  });
});
