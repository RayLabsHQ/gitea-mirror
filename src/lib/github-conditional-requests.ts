import type { Octokit } from "@octokit/rest";

/**
 * A single cached GitHub response, retained so that a later conditional request
 * which comes back `304 Not Modified` can be served from memory instead of
 * downloading the full body again. Only the fields the mirror actually consumes
 * are stored.
 */
export interface CachedResponse {
  etag: string;
  data: unknown;
  status: number;
  /** Preserved so `octokit.paginate` can keep following pages on a cache hit. */
  link?: string;
}

export interface ConditionalRequestStore {
  get(key: string): CachedResponse | undefined;
  set(key: string, value: CachedResponse): void;
}

/**
 * Process-lifetime, bounded in-memory store. Gitea Mirror runs as a long-lived
 * server whose scheduler re-syncs on an interval, so keeping ETags in memory is
 * enough to turn each repeated poll into a cheap `304`. The bound keeps memory
 * predictable; evicting an entry only costs one full response on the next sync.
 */
export class InMemoryConditionalRequestStore implements ConditionalRequestStore {
  private readonly entries = new Map<string, CachedResponse>();

  constructor(private readonly maxEntries = 5000) {}

  get(key: string): CachedResponse | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: CachedResponse): void {
    // Delete-then-set so Map iteration order approximates LRU for eviction.
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

/**
 * Shared across every client so ETags survive the per-sync re-creation of the
 * Octokit instance (a fresh client is built on each scheduled sync).
 */
export const defaultConditionalRequestStore =
  new InMemoryConditionalRequestStore();

export function conditionalRequestCacheKey(
  scope: string,
  method: string,
  url: string,
): string {
  return `${scope} ${method.toUpperCase()} ${url}`;
}

/**
 * Adds ETag-based conditional requests to an Octokit instance. For every GET it
 * replays the previously stored `If-None-Match`; GitHub then answers `304 Not
 * Modified` — which does not count against the token's primary rate limit —
 * whenever nothing changed, and the cached body is returned in place of a full
 * re-download. Non-GET requests are passed through untouched.
 *
 * The scope isolates cache entries per token/user so one account never reads
 * another's cached data.
 */
export function applyConditionalRequests(
  octokit: Octokit,
  options: { store?: ConditionalRequestStore; scope?: string } = {},
): void {
  // Some tests stub Octokit without the hook system; skip wiring in that case.
  if (typeof (octokit as any)?.hook?.wrap !== "function") return;

  const store = options.store ?? defaultConditionalRequestStore;
  const scope = options.scope ?? "default";

  octokit.hook.wrap("request", async (request: any, requestOptions: any): Promise<any> => {
    const method = String(requestOptions.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      return request(requestOptions);
    }

    // Build the key from the expanded absolute URL, not the route template.
    // Inside the hook `requestOptions.url` is still `/repos/{owner}/{repo}/...`,
    // so keying on it would collapse every repo into a single entry per user +
    // endpoint and stop the 304 path from firing once more than one repo syncs.
    // `octokit.request.endpoint.parse` expands the route (owner/repo + query);
    // the chained `request` argument has no `.endpoint`, so it must come from
    // `octokit.request`.
    const parseEndpoint = (octokit as any)?.request?.endpoint?.parse;
    const expandedUrl =
      typeof parseEndpoint === "function"
        ? parseEndpoint(requestOptions).url
        : requestOptions.url;
    const key = conditionalRequestCacheKey(scope, method, expandedUrl);
    const cached = store.get(key);
    if (cached?.etag) {
      requestOptions.headers = {
        ...requestOptions.headers,
        "if-none-match": cached.etag,
      };
    }

    try {
      const response = await request(requestOptions);
      const etag = response?.headers?.etag;
      if (etag && response.status >= 200 && response.status < 300) {
        store.set(key, {
          etag,
          data: response.data,
          status: response.status,
          link: response.headers?.link,
        });
      }
      return response;
    } catch (error: any) {
      // GitHub answered "not modified": reuse the stored body, presented as a
      // 200 so callers (including octokit.paginate) are unaffected.
      if (error?.status === 304 && cached) {
        return {
          status: 200,
          url: expandedUrl,
          headers: {
            ...(error.response?.headers ?? {}),
            etag: cached.etag,
            ...(cached.link ? { link: cached.link } : {}),
          },
          data: cached.data,
        } as any;
      }
      throw error;
    }
  });
}
