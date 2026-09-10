/**
 * Unit tests for the per-key async mutex used to serialize release
 * reconciliation per destination repository (issue #417).
 */

import { describe, expect, it } from "bun:test";
import { keyedLockCount, withKeyedLock } from "@/lib/utils/keyed-mutex";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withKeyedLock", () => {
  it("runs two callers on the same key strictly one after the other", async () => {
    const events: string[] = [];

    const first = withKeyedLock("repo-a", async () => {
      events.push("a:start");
      await tick(10);
      events.push("a:end");
    });
    const second = withKeyedLock("repo-a", async () => {
      events.push("b:start");
      await tick(1);
      events.push("b:end");
    });

    await Promise.all([first, second]);

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs callers on different keys concurrently", async () => {
    const events: string[] = [];

    await Promise.all([
      withKeyedLock("repo-a", async () => {
        events.push("a:start");
        await tick(10);
        events.push("a:end");
      }),
      withKeyedLock("repo-b", async () => {
        events.push("b:start");
        await tick(10);
        events.push("b:end");
      }),
    ]);

    // Both started before either finished, so no serialization across keys.
    expect(events.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
  });

  it("releases the key when the callback throws, and surfaces the error", async () => {
    const events: string[] = [];

    const failing = withKeyedLock("repo-c", async () => {
      events.push("a:start");
      await tick(1);
      throw new Error("upload exploded");
    });
    const following = withKeyedLock("repo-c", async () => {
      events.push("b:start");
      return "ran anyway";
    });

    await expect(failing).rejects.toThrow("upload exploded");
    expect(await following).toBe("ran anyway");
    expect(events).toEqual(["a:start", "b:start"]);
  });

  it("keeps FIFO order for several waiters on one key", async () => {
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        withKeyedLock("repo-d", async () => {
          order.push(n);
          // Later callers ask for a shorter delay: without the lock they would
          // finish out of order.
          await tick(5 - n);
        })
      )
    );

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("returns the callback's value and forgets the key once nobody is queued", async () => {
    const before = keyedLockCount();

    const value = await withKeyedLock("repo-e", async () => 42);
    expect(value).toBe(42);

    // The cleanup runs in a microtask after the tail settles.
    await tick(0);
    expect(keyedLockCount()).toBe(before);
  });

  it("serializes a second caller that arrives while the first is running", async () => {
    let holderRunning = false;
    let sawOverlap = false;

    const holder = withKeyedLock("repo-f", async () => {
      holderRunning = true;
      await tick(15);
      holderRunning = false;
    });

    await tick(1);
    const waiter = withKeyedLock("repo-f", async () => {
      if (holderRunning) sawOverlap = true;
    });

    await Promise.all([holder, waiter]);
    expect(sawOverlap).toBe(false);
  });
});
