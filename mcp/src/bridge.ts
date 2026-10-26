/**
 * Relays MCP messages between a stdio client and the app's MCP endpoint.
 * The tools live in Gitea Mirror itself (POST /api/mcp), so this side only
 * forwards each JSON-RPC line with the API key and writes back the answer.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BridgeOptions {
  /** App origin plus any BASE_URL prefix, without a trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** Writes one JSON-RPC message to the client (stdout). */
  send: (message: unknown) => void;
  /** Reports something to the person running the client (stderr). */
  log: (text: string) => void;
  fetch?: FetchLike;
  timeoutMs?: number;
}

type JsonRpcId = string | number | null;

const DEFAULT_TIMEOUT_MS = 60_000;

function requestId(message: unknown): JsonRpcId | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const { id, method } = message as { id?: unknown; method?: unknown };
  if (typeof method !== "string") return undefined;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

export function createBridge(options: BridgeOptions) {
  const endpoint = `${options.baseUrl}/api/mcp`;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Answer a request with an error, or log it when the message was a notification. */
  function fail(id: JsonRpcId | undefined, text: string): void {
    if (id === undefined) {
      options.log(text);
      return;
    }
    options.send({ jsonrpc: "2.0", id, error: { code: -32000, message: text } });
  }

  async function relay(line: string): Promise<void> {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      options.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The message is not JSON." } });
      return;
    }
    const id = requestId(message);

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "x-api-key": options.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: line,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        fail(id, `Gitea Mirror at ${options.baseUrl} did not answer within ${timeoutMs / 1000} seconds.`);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      fail(id, `Could not reach Gitea Mirror at ${options.baseUrl}: ${reason}`);
      return;
    }

    if (response.status === 202) return;

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      fail(
        id,
        `${endpoint} answered ${response.status} with something other than JSON. Check that GITEA_MIRROR_URL is the address of the app, including any path prefix.`
      );
      return;
    }

    const isRpc = !!body && typeof body === "object" && (body as { jsonrpc?: unknown }).jsonrpc === "2.0";
    if (!isRpc) {
      fail(
        id,
        response.status === 404
          ? `Gitea Mirror at ${options.baseUrl} has no MCP endpoint. Update it to 3.46.0 or later, and check that GITEA_MIRROR_URL includes any path prefix.`
          : `${endpoint} answered ${response.status}: ${text.slice(0, 300)}`
      );
      return;
    }

    // Errors the endpoint raises before reading the message (a rejected key)
    // carry no id; give them the request's so the client can match them.
    const rpc = body as { id?: JsonRpcId; error?: { message?: string } };
    if (rpc.id === null && id !== undefined) {
      options.send({ ...rpc, id });
    } else if (id === undefined && rpc.error) {
      options.log(rpc.error.message ?? JSON.stringify(rpc.error));
    } else {
      options.send(rpc);
    }
  }

  return { endpoint, relay };
}
