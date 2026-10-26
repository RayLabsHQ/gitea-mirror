/**
 * The MCP tools act through the app's own REST API (docs/API.md), with the
 * credential the MCP request came with, so every route's checks and the
 * read only key rule apply exactly as they do for a script. Writes always
 * send a JSON content type, which the app requires even without a body.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RestClientOptions {
  /** Where the app answers locally, plus any BASE_URL prefix. */
  baseUrl: string;
  /** The caller's credential, sent on every request (the x-api-key header). */
  credentialHeaders: Record<string, string>;
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

export class RestClient {
  readonly baseUrl: string;
  private readonly credentialHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: RestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credentialHeaders = options.credentialHeaders;
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
    const headers: Record<string, string> = { ...this.credentialHeaders, Accept: "application/json" };
    if (method !== "GET") headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApiError(
        `Gitea Mirror could not reach its own API at ${this.baseUrl}: ${reason}. If the app listens somewhere else, set MCP_INTERNAL_URL.`,
        0
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(
        `${method} ${path} answered ${response.status} with something other than JSON. If the app listens somewhere else, set MCP_INTERNAL_URL.`,
        response.status
      );
    }

    if (response.ok || accept.includes(response.status)) {
      return { status: response.status, body: parsed as T };
    }

    const detail = errorText(parsed) ?? response.statusText ?? "request failed";
    throw new ApiError(`${method} ${path} failed with ${response.status}: ${detail}`, response.status, errorCode(parsed));
  }
}
