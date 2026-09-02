/**
 * A small global limit on concurrent git runs. API calls are cheap; a
 * clone or a mirror push is not, so the engine keeps only a couple in
 * flight no matter how many mirror jobs the routes start at once.
 */

export const DEFAULT_PUSH_CONCURRENCY = 2;

export function resolvePushConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PUSH_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_PUSH_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PUSH_CONCURRENCY;
  return Math.min(parsed, 32);
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(public readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

let shared: Semaphore | null = null;

/** The process-wide limiter, sized from PUSH_CONCURRENCY on first use. */
export function getPushLimiter(): Semaphore {
  if (!shared) shared = new Semaphore(resolvePushConcurrency());
  return shared;
}

/** Test hook: replace the shared limiter. */
export function resetPushLimiter(limit?: number): Semaphore {
  shared = new Semaphore(limit ?? resolvePushConcurrency());
  return shared;
}
