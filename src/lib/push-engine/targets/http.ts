/**
 * fetch wrapper for the target adapters: JSON in, JSON out, PushTargetError
 * on a non-2xx status. Built on the global fetch so tests can swap it.
 *
 * The URL is checked again on every request and every redirect: the check when
 * the destination was saved says nothing about where the name points now.
 * Redirects still work, because hosts use them for moved projects and renamed
 * repositories.
 */
import { guardedFetch, OutboundUrlError } from "@/lib/utils/outbound-url";
import { PushTargetError } from "./types";

export const DEFAULT_TARGET_TIMEOUT_MS = 30_000;

export interface TargetFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface TargetFetchResult<T> {
  data: T;
  status: number;
}

export async function targetFetch<T>(
  url: string,
  init: TargetFetchInit = {}
): Promise<TargetFetchResult<T>> {
  const { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TARGET_TIMEOUT_MS } = init;

  let response: Response;
  try {
    response = await guardedFetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof OutboundUrlError) {
      throw new PushTargetError(error.message, undefined, url);
    }
    throw error;
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // The status carries the meaning; the body is for the message only.
    }
    throw new PushTargetError(
      `${method} ${redact(url)} failed with status ${response.status}${
        summarize(text) ? `: ${summarize(text)}` : ""
      }`,
      response.status,
      url
    );
  }

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return { data: undefined as T, status: response.status };
  }
  const text = await response.text();
  if (!text) return { data: undefined as T, status: response.status };
  return { data: JSON.parse(text) as T, status: response.status };
}

export function isTargetNotFound(error: unknown): boolean {
  return error instanceof PushTargetError && error.status === 404;
}

function summarize(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown; errors?: unknown };
    const message = parsed.message ?? parsed.error;
    if (typeof message === "string") {
      const errors = Array.isArray(parsed.errors)
        ? parsed.errors
            .map((entry) =>
              typeof entry === "string"
                ? entry
                : entry && typeof entry === "object" && "message" in entry
                  ? String((entry as { message: unknown }).message)
                  : ""
            )
            .filter(Boolean)
            .join("; ")
        : "";
      return `${message}${errors ? ` (${errors})` : ""}`.slice(0, 300);
    }
    if (message && typeof message === "object") return JSON.stringify(message).slice(0, 300);
  } catch {
    // Not JSON.
  }
  return body.slice(0, 300);
}

/** Drop the query string from a URL before it lands in an error message. */
function redact(url: string): string {
  return url.split("?")[0];
}
