import type { APIRoute } from "astro";
import { API_KEY_HEADER } from "@/lib/api-keys";
import { RestClient } from "@/lib/mcp/client";
import { internalApiBaseUrl } from "@/lib/mcp/internal-url";
import { handleMcpMessage, jsonRpcError, parseErrorResponse, type JsonRpcResponse } from "@/lib/mcp/protocol";

/**
 * The MCP endpoint (docs: mcp/README.md). Clients send one JSON-RPC message
 * per POST with an API key; the tools act through the REST API with that
 * same key, so a read only key can use the read tools and is refused on the
 * rest by the usual rule. A browser session is not enough on its own, so a
 * page cannot drive the endpoint with a visitor's cookie.
 */

function rpcResponse(body: JsonRpcResponse, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const apiKey = request.headers.get(API_KEY_HEADER)?.trim();
  if (!apiKey || !locals.user) {
    return rpcResponse(
      jsonRpcError(
        null,
        -32001,
        apiKey
          ? "Gitea Mirror rejected the API key; it may be revoked or expired."
          : `Send an API key in the ${API_KEY_HEADER} header. Create one on the Configuration page, Authentication tab.`
      ),
      401
    );
  }

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return rpcResponse(parseErrorResponse(), 400);
  }

  const client = new RestClient({
    baseUrl: internalApiBaseUrl(),
    credentialHeaders: { [API_KEY_HEADER]: apiKey },
  });
  const response = await handleMcpMessage(message, client, process.env.npm_package_version || "unknown");
  if (!response) return new Response(null, { status: 202 });
  return rpcResponse(response, response.error && response.id === null ? 400 : 200);
};

// The server never pushes messages, so there is no stream to open and no
// session to end.
const methodNotAllowed: APIRoute = () =>
  new Response(JSON.stringify({ success: false, error: "The MCP endpoint takes POST only." }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST" },
  });

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
