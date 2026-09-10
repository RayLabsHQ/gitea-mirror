import { describe, test, expect, mock } from "bun:test";
import { processInParallel, processWithRetry } from "./concurrency";

describe("processInParallel", () => {
  test("processes items in parallel with concurrency control", async () => {
    // Create an array of numbers to process
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    // Create a mock function to track execution
    const processItem = mock(async (item: number) => {
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 10));
      return item * 2;
    });

    // Create a mock progress callback
    const onProgress = mock((completed: number, total: number, result?: number) => {
      // Progress tracking
    });

    // Process the items with a concurrency limit of 3
    const results = await processInParallel(
      items,
      processItem,
      3,
      onProgress
    );

    // Verify results
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);

    // Verify that processItem was called for each item
    expect(processItem).toHaveBeenCalledTimes(10);

    // Verify that onProgress was called for each item
    expect(onProgress).toHaveBeenCalledTimes(10);

    // Verify the last call to onProgress had the correct completed/total values
    expect(onProgress.mock.calls[9][0]).toBe(10); // completed
    expect(onProgress.mock.calls[9][1]).toBe(10); // total
  });

  test("handles errors in processing", async () => {
    // Create an array of numbers to process
    const items = [1, 2, 3, 4, 5];

    // Create a mock function that throws an error for item 3
    const processItem = mock(async (item: number) => {
      if (item === 3) {
        throw new Error("Test error");
      }
      return item * 2;
    });

    // Create a spy for console.error
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => {});
    console.error = consoleErrorMock;

    try {
      // Process the items
      const results = await processInParallel(items, processItem);

      // Verify results (should have 4 items, missing the one that errored)
      expect(results).toEqual([2, 4, 8, 10]);

      // Verify that processItem was called for each item
      expect(processItem).toHaveBeenCalledTimes(5);

      // Verify that console.error was called (enhanced logging calls it multiple times)
      expect(consoleErrorMock).toHaveBeenCalled();
    } finally {
      // Restore console.error
      console.error = originalConsoleError;
    }
  });
});

describe("processWithRetry", () => {
  test("retries failed operations", async () => {
    // Create an array of numbers to process
    const items = [1, 2, 3];

    // Create a counter to track retry attempts
    const attemptCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };

    // Create a mock function that fails on first attempt for item 2
    const processItem = mock(async (item: number) => {
      attemptCounts[item]++;

      if (item === 2 && attemptCounts[item] === 1) {
        throw new Error("Temporary error");
      }

      return item * 2;
    });

    // Create a mock for the onRetry callback
    const onRetry = mock((item: number, error: Error, attempt: number) => {
      // Retry tracking
    });

    // Process the items with retry
    const results = await processWithRetry(items, processItem, {
      maxRetries: 2,
      retryDelay: 10,
      onRetry,
    });

    // Verify results
    expect(results).toEqual([2, 4, 6]);

    // Verify that item 2 was retried once
    expect(attemptCounts[1]).toBe(1); // No retries
    expect(attemptCounts[2]).toBe(2); // One retry
    expect(attemptCounts[3]).toBe(1); // No retries

    // Verify that onRetry was called once
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toBe(2); // item
    expect(onRetry.mock.calls[0][2]).toBe(1); // attempt
  });

  test("gives up after max retries", async () => {
    // Create an array of numbers to process
    const items = [1, 2];

    // Create a mock function that always fails for item 2
    const processItem = mock(async (item: number) => {
      if (item === 2) {
        throw new Error("Persistent error");
      }
      return item * 2;
    });

    // Create a mock for the onRetry callback
    const onRetry = mock((item: number, error: Error, attempt: number) => {
      // Retry tracking
    });

    // Create a spy for console.error
    const originalConsoleError = console.error;
    const consoleErrorMock = mock(() => {});
    console.error = consoleErrorMock;

    try {
      // Process the items with retry
      const results = await processWithRetry(items, processItem, {
        maxRetries: 2,
        retryDelay: 10,
        onRetry,
      });

      // Verify results (should have 1 item, missing the one that errored)
      expect(results).toEqual([2]);

      // Verify that onRetry was called twice (for 2 retry attempts)
      expect(onRetry).toHaveBeenCalledTimes(2);

      // Verify that console.error was called (enhanced logging calls it multiple times)
      expect(consoleErrorMock).toHaveBeenCalled();
    } finally {
      // Restore console.error
      console.error = originalConsoleError;
    }
  });
});

describe("processWithRetry checkpointing", () => {
  test("records every completed item and publishes on the interval", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const calls: Array<[string, string, boolean]> = [];

    await processWithRetry(items, async (item) => item.toUpperCase(), {
      concurrencyLimit: 1,
      jobId: "job-1",
      getItemId: (item) => item,
      checkpointInterval: 2,
      onCheckpoint: async (jobId, itemId, publish) => {
        calls.push([jobId, itemId, publish]);
      },
    });

    // One checkpoint per item, in completion order, and no "final" placeholder.
    expect(calls.map(([, itemId]) => itemId)).toEqual(items);
    expect(calls.every(([jobId]) => jobId === "job-1")).toBe(true);
    // Progress events only every second item.
    expect(calls.map(([, , publish]) => publish)).toEqual([false, true, false, true, false]);
  });

  test("does not checkpoint an item that failed for good", async () => {
    const calls: string[] = [];

    // processInParallel logs a failed item and carries on, so the call resolves.
    await processWithRetry(["ok", "bad"], async (item) => {
      if (item === "bad") throw new Error("nope");
      return item;
    }, {
      concurrencyLimit: 1,
      maxRetries: 0,
      jobId: "job-2",
      getItemId: (item) => item,
      onCheckpoint: async (_jobId, itemId) => {
        calls.push(itemId);
      },
    });

    expect(calls).toEqual(["ok"]);
  });
});
