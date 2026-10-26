import { RestClient, type FetchLike } from "./client";
import { handleMcpMessage } from "./protocol";

export const BASE_URL = "http://127.0.0.1:4321/base";
export const API_KEY = "gm_test-key";

export interface RecordedCall {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

export type FakeRoute = (body: any) => { status?: number; body: unknown } | Response;

/**
 * A stand-in for the app's REST API. Routes are keyed "METHOD /api/...",
 * without the base path, and every request is recorded.
 */
export function fakeApi(routes: Record<string, FakeRoute>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.startsWith("/base/") ? url.pathname.slice("/base".length) : url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, headers: new Headers(init?.headers), body });

    const route = routes[`${method} ${path}`];
    if (!route) {
      return Response.json({ success: false, error: `No API endpoint for ${method} ${path}.` }, { status: 404 });
    }
    const result = route(body);
    if (result instanceof Response) return result;
    return Response.json(result.body, { status: result.status ?? 200 });
  };
  return { fetch, calls };
}

export function clientFor(routes: Record<string, FakeRoute>) {
  const api = fakeApi(routes);
  const client = new RestClient({ baseUrl: `${BASE_URL}/`, credentialHeaders: { "x-api-key": API_KEY }, fetch: api.fetch });
  return { client, calls: api.calls };
}

let nextId = 1;

/** Send one JSON-RPC request through the protocol handler. */
export async function rpc(client: RestClient, method: string, params?: Record<string, unknown>) {
  return handleMcpMessage({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }, client, "test");
}

/** Tool calls against fake routes, recording every REST call they make. */
export function toolSession(routes: Record<string, FakeRoute>) {
  const { client, calls } = clientFor(routes);
  return {
    calls,
    async call(name: string, args: Record<string, unknown> = {}) {
      const response = await rpc(client, "tools/call", { name, arguments: args });
      const result = response?.result as { content: Array<{ text: string }>; isError?: boolean };
      const text = result.content[0]?.text ?? "";
      const isError = result.isError === true;
      return { isError, text, data: isError ? undefined : JSON.parse(text) };
    },
  };
}
