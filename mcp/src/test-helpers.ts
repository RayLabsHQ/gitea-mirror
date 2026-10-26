import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GiteaMirrorClient, type FetchLike } from "./client";
import { createServer } from "./server";

export const BASE_URL = "http://mirror.test/base";
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

/** An MCP client connected in memory to a server that talks to the fake API. */
export async function connect(routes: Record<string, FakeRoute>) {
  const api = fakeApi(routes);
  const server = createServer(new GiteaMirrorClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: api.fetch }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return { mcp, calls: api.calls };
}

export async function callTool(mcp: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await mcp.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  const isError = result.isError === true;
  return { isError, text, data: isError ? undefined : JSON.parse(text) };
}
