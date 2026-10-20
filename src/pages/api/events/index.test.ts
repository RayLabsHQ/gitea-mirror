/**
 * Regression test for #465: a client disconnect took the whole server down.
 *
 * The node adapter cancels the stream reader when the socket closes and then
 * fires the request's abort signal. On Bun 1.4 the cancel has already closed
 * the stream, so an unguarded controller.close() in the abort listener throws
 * ERR_INVALID_STATE as an uncaught exception, and the uncaught-exception
 * handler shut the process down. Both SSE routes are covered.
 *
 * The routes import @/lib/auth-guards and @/lib/events, replaced here with
 * mock.module, which is process wide in bun, so the suite runs in an isolated
 * child process (same harness as the other route tests).
 */

import { describe, expect, mock, test } from "bun:test";

const CHILD_FLAG = "GM_SSE_ROUTES_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("SSE routes - isolated child suite", () => {
    const res = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, [CHILD_FLAG]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) {
      console.error(res.stdout.toString());
      console.error(res.stderr.toString());
    }
    expect(res.exitCode).toBe(0);
  }, 60_000);
}

if (isChild) {
  mock.module("@/lib/auth-guards", () => ({
    requireAuthenticatedUserId: async () => ({ userId: "user-1" }),
  }));
  mock.module("@/lib/events", () => ({
    getNewEvents: async () => [],
  }));
}

const routes = isChild
  ? {
      events: (await import("./index")).GET,
      sse: (await import("../sse/index")).GET,
    }
  : ({} as Record<string, any>);

/**
 * Opens the stream, then closes it the way the node adapter does on a
 * disconnect: the reader is cancelled first, the abort signal fires second.
 */
async function disconnect(route: any) {
  const abort = new AbortController();
  const request = new Request("http://localhost/api/x", { signal: abort.signal });
  const response = await route({ request, locals: {} });
  const reader = response.body.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain(": connected");

  const uncaught: unknown[] = [];
  const record = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", record);
  try {
    await reader.cancel();
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("uncaughtException", record);
  }
  return uncaught;
}

describe.skipIf(!isChild)("SSE routes survive a client disconnect (#465)", () => {
  test("/api/events", async () => {
    expect(await disconnect(routes.events)).toEqual([]);
  });

  test("/api/sse", async () => {
    expect(await disconnect(routes.sse)).toEqual([]);
  });
});
