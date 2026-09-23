/**
 * In-memory gate for source rate limits (issue #437).
 *
 * A GitHub primary rate limit resets at a fixed time that can be close to an
 * hour away. Sleeping through that window inside an Octokit request holds the
 * scheduler lock for the whole run, and every following tick logs "Scheduler
 * is already running, skipping this cycle" until the process restarts.
 *
 * The throttle handler records the reset here and fails the request instead of
 * sleeping. The scheduler reads the gate between batches and between
 * repositories, ends the run early and schedules the next one just after the
 * reset, so nothing is stuck and the lock is released as usual.
 *
 * The state is process local on purpose: it is a coordination hint for the
 * work running right now, not durable state. RateLimitManager
 * (src/lib/rate-limit-manager.ts) still persists the per-user numbers.
 */

/** Gate key for clients built without a user, such as tokenless public sources. */
export const TOKENLESS_RATE_LIMIT_KEY = "anonymous";

/** Reset time (epoch ms) per key, for the keys that are currently limited. */
const resetTimesByKey = new Map<string, number>();

/**
 * The gate key for a user. Clients created without a userId share one key, so
 * a tokenless source that runs into the anonymous limit still pauses.
 */
export function rateLimitGateKey(userId?: string | null): string {
  const trimmed = typeof userId === "string" ? userId.trim() : "";
  return trimmed === "" ? TOKENLESS_RATE_LIMIT_KEY : trimmed;
}

/**
 * Record that this key is rate limited until `resetAt`. A reset that is
 * further out than the one already recorded wins: two endpoints can report
 * different windows and the work has to wait for the later one.
 */
export function markRateLimited(key: string, resetAt: Date | number): void {
  const resetMs = resetAt instanceof Date ? resetAt.getTime() : resetAt;
  if (!Number.isFinite(resetMs)) {
    return;
  }

  const current = resetTimesByKey.get(key);
  if (current !== undefined && current >= resetMs) {
    return;
  }

  resetTimesByKey.set(key, resetMs);
}

/**
 * The reset time while the key is still rate limited, otherwise null. A reset
 * that has passed is forgotten on read, so the gate opens on its own.
 */
export function rateLimitedUntil(key: string, now: Date = new Date()): Date | null {
  const resetMs = resetTimesByKey.get(key);
  if (resetMs === undefined) {
    return null;
  }

  if (resetMs <= now.getTime()) {
    resetTimesByKey.delete(key);
    return null;
  }

  return new Date(resetMs);
}

/** Open the gate for one key, for example after a request came back with budget left. */
export function clearRateLimit(key: string): void {
  resetTimesByKey.delete(key);
}

/** Open the gate for every key. Used by tests and by a full restart of the scheduler. */
export function clearAllRateLimits(): void {
  resetTimesByKey.clear();
}

/**
 * Whether an error is a rate limit refusal from the source.
 *
 * Octokit raises 403 with "rate limit" in the message for the primary and
 * secondary limits and 429 for too many requests. Callers in between re-throw
 * some of those with only the message (gitea.ts wraps mirror failures in a
 * plain Error), so the message alone has to be enough when no status survived.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const candidate = error as { status?: unknown; response?: { status?: unknown }; message?: unknown };
  const rawStatus = candidate.status ?? candidate.response?.status;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;

  if (status === 429) {
    return true;
  }

  const message =
    typeof candidate.message === "string" ? candidate.message : String(error);
  const mentionsRateLimit = /rate limit/i.test(message);

  if (!mentionsRateLimit) {
    return false;
  }

  // With a status attached, only the two GitHub uses of the phrase count.
  // Without one the error has been re-thrown along the way, and the message is
  // all that is left to go on.
  return status === undefined || status === 403;
}

/**
 * The error a gated request fails with before anything is sent. Shaped like
 * Octokit's own primary rate limit refusal (status 403, "rate limit" in the
 * message) so every existing `isRateLimitError` check treats it the same.
 */
export class RateLimitPausedError extends Error {
  readonly status = 403;
  readonly resetAt: Date;

  constructor(resetAt: Date, endpoint?: string) {
    super(
      `GitHub API rate limit exceeded; requests are paused until ${resetAt.toISOString()}` +
        (endpoint ? ` (not sent: ${endpoint})` : "")
    );
    this.name = "RateLimitPausedError";
    this.resetAt = resetAt;
  }
}

/**
 * Endpoints that never count against the limit and are needed to learn when
 * it opens again. Everything else is held while the gate is closed.
 */
const GATE_EXEMPT_ROUTES = [/\/rate_limit(\?|$)/];

export interface RateLimitGateOptions {
  /** Gate key of this client, from rateLimitGateKey(). */
  key: string;
  /**
   * A closed gate that opens again within this many milliseconds is waited
   * out inside the request instead of failing it, so a short primary or
   * secondary limit stays invisible to the caller. Longer waits fail at once.
   */
  maxWaitMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * Hold every request of an Octokit client while its gate is closed
 * (issue #437, second report).
 *
 * The throttle handler records a reset time when a request is refused, but
 * on its own that only affects the one request: every other call queued in
 * the same run still went to GitHub and came back 403, and the retry helper
 * sent each of them three more times. GitHub counts requests made while
 * limited toward abuse detection, and one reporter's account was suspended
 * that way. This wrap runs before the network: a closed gate either waits
 * (short reset) or throws (long reset), and nothing leaves the process.
 */
export function installRateLimitGate(octokit: unknown, options: RateLimitGateOptions): void {
  const hook = (octokit as { hook?: { wrap?: unknown } })?.hook;
  if (typeof hook?.wrap !== "function") return;

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());

  (hook.wrap as (name: string, wrapper: (request: any, requestOptions: any) => Promise<any>) => void)(
    "request",
    async (request, requestOptions) => {
      const url = String(requestOptions?.url ?? "");
      if (GATE_EXEMPT_ROUTES.some((route) => route.test(url))) {
        return request(requestOptions);
      }

      const until = rateLimitedUntil(options.key, now());
      if (until) {
        const waitMs = until.getTime() - now().getTime();
        if (waitMs > options.maxWaitMs) {
          throw new RateLimitPausedError(until, `${requestOptions?.method ?? "GET"} ${url}`);
        }
        // Small cushion: GitHub's reset is second precision.
        await sleep(waitMs + 1000);
      }

      return request(requestOptions);
    }
  );
}
