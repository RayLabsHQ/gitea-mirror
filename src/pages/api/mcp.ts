import type { APIRoute } from "astro";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcpRequest, MCP_READ_SCOPE, MCP_SYNC_SCOPE, MCP_SETTINGS_SCOPE } from "@/lib/mcp/auth";
import { createMcpServer } from "@/lib/mcp/server";

export function hasMcpToolScope(scopes: string[]): boolean {
  return scopes.includes(MCP_READ_SCOPE) || scopes.includes(MCP_SYNC_SCOPE) || scopes.includes(MCP_SETTINGS_SCOPE);
}

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

export async function dispatchMcpOperation(input: {
  userId: string;
  operation: "sync-repositories" | "mirror-repositories" | "sync-organization" | "mirror-organizations" | "reset-metadata" | "move-repository" | "move-organization" | "reconcile" | "resolve-sync-alert" | "set-organization-status" | "set-organization-settings" | "set-repository-settings" | "set-repository-status" | "delete-repositories" | "delete-organization" | "import-repository" | "import-organization" | "refresh-repository-metadata";
  ids?: string[];
  body?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const routes: Record<typeof input.operation, () => Promise<{ POST: (context: never) => Promise<Response> }>> = {
    "sync-repositories": () => import("./job/sync-repo"),
    "mirror-repositories": () => import("./job/mirror-repo"),
    "sync-organization": () => import("./job/sync-org"),
    "mirror-organizations": () => import("./job/mirror-org"),
    "reset-metadata": () => import("./job/reset-metadata"),
    "move-repository": () => import("./repositories/[id]/move-mirror"),
    "move-organization": () => import("./organizations/[id]/move-mirrors"),
    reconcile: () => import("./cleanup/reconcile"),
    "resolve-sync-alert": () => import("./job/approve-sync"),
    "set-organization-status": () => import("./organizations/[id]/status"),
    "set-organization-settings": () => import("./organizations/[id]"),
    "set-repository-settings": () => import("./repositories/[id]"),
    "set-repository-status": () => import("./repositories/[id]/status"),
    "delete-repositories": () => import("./repositories/index"),
    "delete-organization": () => import("./organizations/[id]"),
    "import-repository": () => import("./sync/repository"),
    "import-organization": () => import("./sync/organization"),
    "refresh-repository-metadata": () => import("./sync/repository"),
  };
  const operation = input.operation;
  const route = await routes[operation]();
  const body = operation === "delete-repositories" ? { ids: input.ids }
    : operation === "delete-organization" ? {}
    : operation === "import-repository" || operation === "refresh-repository-metadata" ? input.body
    : operation === "import-organization" ? input.body
    : operation === "sync-organization" ? { orgId: input.ids?.[0] }
    : operation === "resolve-sync-alert" ? { repositoryIds: input.ids, ...(input.body ?? {}) }
    : operation === "set-organization-status" ? input.body
    : operation === "set-organization-settings" || operation === "set-repository-settings" || operation === "set-repository-status" ? input.body
    : operation === "move-repository" ? { destinationOrg: input.body?.destinationOwner }
    : operation === "move-organization" ? input.body
    : operation === "reconcile" ? input.body
    : { repositoryIds: input.ids, organizationIds: input.ids, ...(input.body ?? {}) };
  const request = new Request(`http://localhost/api/mcp/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await (operation === "delete-repositories" || operation === "delete-organization" ? (route as any).DELETE : ["set-organization-status", "set-organization-settings", "set-repository-settings", "set-repository-status"].includes(operation) ? (route as any).PATCH : route.POST)({
    request,
    params: ["move-repository", "move-organization", "set-organization-status", "set-organization-settings", "set-repository-settings", "set-repository-status", "delete-organization"].includes(operation) ? { id: input.ids?.[0] } : {},
    locals: { session: { userId: input.userId }, user: { id: input.userId } },
  } as never);
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : typeof payload.error === "string" ? payload.error : "MCP operation failed");
  return {
    accepted: payload.success !== false,
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    ...(payload.queued && typeof payload.queued === "object" ? { queued: payload.queued } : {}),
    ...(typeof payload.dryRun === "boolean" ? { dryRun: payload.dryRun } : {}),
    ...(typeof payload.destinationOrg === "string" || payload.destinationOrg === null ? { destinationOrg: payload.destinationOrg } : {}),
    ...(Array.isArray(payload.repositories) ? { repositories: payload.repositories.map((r: any) => ({ name: r.name, status: r.status, outcome: r.outcome })) } : {}),
    ...(Array.isArray(payload.items) ? { items: payload.items.map((r: any) => ({ name: r.name, action: r.action, reason: r.reason })) } : {}),
  };
}

export const ALL: APIRoute = async ({ request }) => {
  const principal = await authenticateMcpRequest(request);
  if (principal instanceof Response) return principal;
  if (!hasMcpToolScope(principal.scopes)) {
    return bearerChallenge(`${MCP_READ_SCOPE} ${MCP_SYNC_SCOPE} ${MCP_SETTINGS_SCOPE}`);
  }

  const server = createMcpServer({
    userId: principal.userId,
    scopes: principal.scopes,
    dispatchSync: dispatchRepositorySync,
    dispatchOperation: dispatchMcpOperation,
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
