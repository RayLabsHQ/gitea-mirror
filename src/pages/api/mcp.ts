import type { APIRoute } from "astro";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcpRequest, MCP_READ_SCOPE, MCP_SYNC_SCOPE, mcpUnauthorizedResponse } from "@/lib/mcp/auth";
import { createMcpServer } from "@/lib/mcp/server";

const bearerChallenge = (scope: string) => new Response(
  JSON.stringify({ error: "insufficient_scope", required_scope: scope }),
  {
    status: 403,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
      "Cache-Control": "no-store",
    },
  },
);

async function dispatchRepositorySync(input: {
  userId: string;
  repositoryId: string;
  retry: boolean;
}): Promise<unknown> {
  const route = input.retry
    ? await import("./job/retry-repo")
    : await import("./job/sync-repo");
  const request = new Request(`http://localhost/api/job/${input.retry ? "retry-repo" : "sync-repo"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryIds: [input.repositoryId] }),
  });
  const response = await route.POST({
    request,
    locals: { session: { userId: input.userId } },
  } as never);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.message === "string" ? payload.message : "Could not queue repository sync");
  }
  return toMcpSyncResult(payload);
}

export function toMcpSyncResult(payload: unknown): Record<string, unknown> {
  const result = payload && typeof payload === "object"
    ? payload as { message?: unknown; repositories?: unknown }
    : {};
  const repositories = Array.isArray(result.repositories)
    ? result.repositories.map((repo) => {
        if (!repo || typeof repo !== "object") return {};
        const row = repo as { id?: unknown; name?: unknown; status?: unknown };
        return {
          ...(typeof row.id === "string" ? { id: row.id } : {}),
          ...(typeof row.name === "string" ? { name: row.name } : {}),
          ...(typeof row.status === "string" ? { status: row.status } : {}),
        };
      })
    : [];
  return {
    accepted: true,
    ...(typeof result.message === "string" ? { message: result.message } : {}),
    repositories,
  };
}

export const ALL: APIRoute = async ({ request }) => {
  const principal = await authenticateMcpRequest(request);
  if (principal instanceof Response) return principal;
  if (!principal.scopes.includes(MCP_READ_SCOPE) && !principal.scopes.includes(MCP_SYNC_SCOPE)) {
    return bearerChallenge(`${MCP_READ_SCOPE} ${MCP_SYNC_SCOPE}`);
  }

  const server = createMcpServer({
    userId: principal.userId,
    scopes: principal.scopes,
    dispatchSync: dispatchRepositorySync,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
};
