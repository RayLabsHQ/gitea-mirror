import { isRateLimitError } from "@/lib/rate-limit-gate";

/**
 * Work an API route starts and does not wait for: the mirror, sync and retry
 * batches. The route has already answered by the time the work fails, so
 * nothing above it catches the error. Left alone it becomes an unhandled
 * rejection, and signal-handlers.ts shuts the whole server down for it. That
 * is how one exhausted GitHub budget during a manual sync of a few
 * repositories took the app down (#557).
 *
 * The job row is already marked failed by processWithResilience before the
 * error gets here, so this only has to keep it from escaping and log it.
 */
export async function runBackgroundTask(
  label: string,
  task: () => Promise<unknown>
): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (isRateLimitError(error)) {
      // Expected: the batch stopped instead of sending requests GitHub would
      // refuse. Items it did not reach keep their status.
      console.warn(
        `[${label}] Stopped by the source rate limit; repositories it did not reach were left as they were: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    console.error(`[${label}] Background job failed:`, error);
  }
}

/** Starts `task` after the current request returns, via runBackgroundTask. */
export function runInBackground(label: string, task: () => Promise<unknown>): void {
  setTimeout(() => {
    void runBackgroundTask(label, task);
  }, 0);
}
