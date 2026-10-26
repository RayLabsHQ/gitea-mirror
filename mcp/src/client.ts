/**
 * A small client for the Gitea Mirror REST API (docs/API.md). Every call
 * carries the API key in the x-api-key header, and writes always send a
 * JSON content type, which the app requires even when there is no body.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiResponse<T> {
  status: number;
  body: T;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function errorText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof error === "string" && error.trim()) return error;
  if (typeof message === "string" && message.trim()) return message;
  return undefined;
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { code } = body as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

export class GiteaMirrorClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request<T>("GET", path)).body;
  }

  /**
   * POST a JSON body. Statuses listed in `accept` come back as a response
   * instead of an error, for calls where they carry a usable record (the
   * 409 of an add call holds the stored repository or organization).
   */
  async post<T>(path: string, body: unknown, accept: number[] = []): Promise<ApiResponse<T>> {
    return this.request<T>("POST", path, body, accept);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    accept: number[] = []
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      Accept: "application/json",
    };
    if (method !== "GET") headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApiError(`Could not reach Gitea Mirror at ${this.baseUrl}: ${reason}`, 0);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // An HTML page here usually means the URL is not the app itself, or
      // misses the BASE_URL prefix the app is served under.
      throw new ApiError(
        `${method} ${path} answered ${response.status} with something other than JSON. Check that GITEA_MIRROR_URL is the address of the app, including any path prefix.`,
        response.status
      );
    }

    if (response.ok || accept.includes(response.status)) {
      return { status: response.status, body: parsed as T };
    }

    const code = errorCode(parsed);
    if (response.status === 401) {
      throw new ApiError(
        "Gitea Mirror rejected the API key (401). Check GITEA_MIRROR_API_KEY; the key may be revoked or expired.",
        401,
        code
      );
    }
    const detail = errorText(parsed) ?? response.statusText ?? "request failed";
    throw new ApiError(`${method} ${path} failed with ${response.status}: ${detail}`, response.status, code);
  }
}
