import { describe, expect, test } from "bun:test";
import { createBridge, type FetchLike } from "./bridge";

const BASE_URL = "http://mirror.test/base";
const API_KEY = "gm_test-key";

function bridgeWith(answer: FetchLike) {
  const sent: any[] = [];
  const logged: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const bridge = createBridge({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    send: (message) => sent.push(message),
    log: (text) => logged.push(text),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return answer(url, init);
    },
  });
  return { bridge, sent, logged, requests };
}

const ping = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" });

describe("bridge", () => {
  test("posts each message to the endpoint with the key and writes the answer back", async () => {
    const { bridge, sent, requests } = bridgeWith(async () => Response.json({ jsonrpc: "2.0", id: 7, result: {} }));
    await bridge.relay(ping);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${BASE_URL}/api/mcp`);
    const headers = new Headers(requests[0].init?.headers);
    expect(headers.get("x-api-key")).toBe(API_KEY);
    expect(headers.get("content-type")).toBe("application/json");
    expect(requests[0].init?.body).toBe(ping);
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
  });

  test("a notification the endpoint accepts writes nothing", async () => {
    const { bridge, sent } = bridgeWith(async () => new Response(null, { status: 202 }));
    await bridge.relay(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(sent).toEqual([]);
  });

  test("a rejected key comes back as an error for the request that hit it", async () => {
    const { bridge, sent } = bridgeWith(async () =>
      Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Gitea Mirror rejected the API key." } },
        { status: 401 }
      )
    );
    await bridge.relay(ping);
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: -32001, message: "Gitea Mirror rejected the API key." } }]);
  });

  test("an unreachable app answers the request without echoing the key", async () => {
    const { bridge, sent } = bridgeWith(async () => {
      throw new TypeError("fetch failed");
    });
    await bridge.relay(ping);
    expect(sent[0].id).toBe(7);
    expect(sent[0].error.message).toBe(`Could not reach Gitea Mirror at ${BASE_URL}: fetch failed`);
    expect(JSON.stringify(sent)).not.toContain(API_KEY);
  });

  test("a slow app is reported as a timeout", async () => {
    const sent: any[] = [];
    const bridge = createBridge({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      send: (message) => sent.push(message),
      log: () => {},
      timeoutMs: 50,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    });
    await bridge.relay(ping);
    expect(sent[0].error.message).toBe(`Gitea Mirror at ${BASE_URL} did not answer within 0.05 seconds.`);
  });

  test("an app without the endpoint is told to update", async () => {
    const { bridge, sent } = bridgeWith(async () =>
      Response.json({ success: false, error: "No API endpoint for POST /api/mcp." }, { status: 404 })
    );
    await bridge.relay(ping);
    expect(sent[0].error.message).toContain("has no MCP endpoint. Update it to 3.46.0 or later");
  });

  test("an HTML page points at the URL", async () => {
    const { bridge, sent } = bridgeWith(async () => new Response("<!doctype html>", { status: 200 }));
    await bridge.relay(ping);
    expect(sent[0].error.message).toContain("Check that GITEA_MIRROR_URL is the address of the app");
  });

  test("a failed notification is logged, not sent", async () => {
    const { bridge, sent, logged } = bridgeWith(async () => {
      throw new TypeError("fetch failed");
    });
    await bridge.relay(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(sent).toEqual([]);
    expect(logged[0]).toContain("Could not reach Gitea Mirror");
  });

  test("a line that is not JSON gets a parse error and no request", async () => {
    const { bridge, sent, requests } = bridgeWith(async () => Response.json({}));
    await bridge.relay("{not json");
    await bridge.relay("   ");
    expect(requests).toHaveLength(0);
    expect(sent).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The message is not JSON." } }]);
  });
});
