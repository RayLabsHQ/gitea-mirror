/**
 * Small fetch wrapper shared by the GitLab and Gitea adapters.
 *
 * Deliberately built on the global fetch so tests can swap it out, and free
 * of database imports so the adapters stay pure.
 */

export const DEFAULT_SOURCE_TIMEOUT_MS = 30_000;

export class SourceApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body?: string
  ) {
    super(message);
    this.name = "SourceApiError";
  }
}

export function isSourceNotFound(error: unknown): boolean {
  return error instanceof SourceApiError && error.status === 404;
}

export interface SourceFetchInit {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface SourceFetchResult<T> {
  data: T;
  response: Response;
}

/** GET JSON from a source host, throwing SourceApiError on a non-2xx status. */
export async function sourceFetch<T>(
  url: string,
  init: SourceFetchInit = {}
): Promise<SourceFetchResult<T>> {
  const { method = "GET", headers = {}, timeoutMs = DEFAULT_SOURCE_TIMEOUT_MS } = init;

  const response = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // The status is what matters; the body is only for diagnostics.
    }
    const detail = summarizeErrorBody(body);
    throw new SourceApiError(
      `Request to ${url} failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
      url,
      body
    );
  }

  if (response.status === 204) {
    return { data: undefined as T, response };
  }

  const data = (await response.json()) as T;
  return { data, response };
}

function summarizeErrorBody(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const message = parsed.message ?? parsed.error;
    if (typeof message === "string") return message.slice(0, 200);
  } catch {
    // Not JSON.
  }
  return body.slice(0, 200);
}

/** Append query parameters, skipping undefined values. */
export function withQuery(
  url: string,
  params: Record<string, string | number | boolean | undefined>
): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined
  );
  if (entries.length === 0) return url;
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/** Coerce an API timestamp to a Date, falling back to now. */
export function toDate(value: unknown): Date {
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

/** Strip a trailing ".git" from a repository name segment. */
export function stripGitSuffix(segment: string): string {
  return segment.replace(/\.git$/i, "");
}
