import { describe, expect, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, mcpLimitSchema, mcpMirrorOptionsSchema, mcpMirrorOverrideSchema, mcpRepositoryIdSchema, mcpScheduleSchema } from "./server";

describe("MCP server registry", () => {
  test("validates bounded limits and repository identifiers", () => {
    expect(mcpLimitSchema.parse(undefined)).toBe(25);
    expect(mcpLimitSchema.safeParse(101).success).toBe(false);
    expect(mcpLimitSchema.safeParse(1.5).success).toBe(false);
    expect(mcpRepositoryIdSchema.safeParse("repo-1").success).toBe(true);
    expect(mcpRepositoryIdSchema.safeParse("  ").success).toBe(false);
    expect(mcpRepositoryIdSchema.safeParse("x".repeat(201)).success).toBe(false);
  });

  test("rejects credential, endpoint, backup, and cleanup options from settings writes", async () => {
    for (const key of ["url", "token", "username", "backupDirectory", "backupStrategy", "blockSyncOnBackupFailure"]) {
      expect(mcpMirrorOptionsSchema.safeParse({ [key]: "unsafe" }).success).toBe(false);
    }
    expect(mcpMirrorOptionsSchema.safeParse({ visibility: "secret" }).success).toBe(false);
    expect(mcpMirrorOptionsSchema.safeParse({ forkStrategy: "clone" }).success).toBe(false);
    expect(mcpMirrorOptionsSchema.safeParse({ releaseType: "preview" }).success).toBe(false);
    expect(mcpMirrorOptionsSchema.safeParse({ mirrorInterval: "10m", issueConcurrency: 3 }).success).toBe(true);
  });

  test("schedule interval uses the stored string form and rejects numeric intervals", async () => {
    expect(mcpScheduleSchema.safeParse({ interval: "0 2 * * *" }).success).toBe(true);
    expect(mcpScheduleSchema.safeParse({ interval: 3600 }).success).toBe(false);
    expect(mcpScheduleSchema.safeParse({ cleanupBeforeMirror: true }).success).toBe(false);
  });

  test("mirror overrides enforce bounded release types, limits, and tag patterns", () => {
    expect(mcpMirrorOverrideSchema.safeParse({ releaseLimit: 1000, releaseType: "stable", releaseIncludeTags: ["v*"] }).success).toBe(true);
    expect(mcpMirrorOverrideSchema.safeParse({ releaseLimit: 1001 }).success).toBe(false);
    expect(mcpMirrorOverrideSchema.safeParse({ releaseType: "preview" }).success).toBe(false);
    expect(mcpMirrorOverrideSchema.safeParse({ releaseIncludeTags: "*" }).success).toBe(false);
    expect(mcpMirrorOverrideSchema.safeParse({ releaseExcludeTags: ["x".repeat(201)] }).success).toBe(false);
    expect(mcpMirrorOverrideSchema.safeParse({ arbitrary: true }).success).toBe(false);
  });

  test("repository reads and exports omit source URLs and raw internal fields", async () => {
    const raw = {
      id: "repo-1", userId: "user-1", name: "project", fullName: "alice/project", owner: "alice",
      url: "https://source.example/private/repo", cloneUrl: "https://token@source.example/repo.git",
      sourceUrl: "https://source.example", destinationUrl: "https://destination.example",
      description: "project", status: "mirrored", defaultBranch: "main",
    };
    const fakeDb: any = {
      select: (projection: Record<string, unknown>) => {
        const projected = Object.fromEntries(Object.keys(projection).map((key) => [key, (raw as any)[key]]));
        const query: any = {
          from: () => query, where: () => query, limit: async () => [projected],
          orderBy: () => Promise.resolve([projected]),
        };
        return query;
      },
    };
    const server = createMcpServer({ userId: "user-1", scopes: ["mirror:read"], db: fakeDb });
    const tools = (server as any)._registeredTools;
    for (const [name, input, key] of [
      ["get_repository", { repositoryId: "repo-1" }, "repository"],
      ["export_repositories", {}, "repositories"],
    ] as const) {
      const response = await tools[name].handler(input);
      const json = JSON.stringify(response.structuredContent[key]);
      expect(json).not.toContain("source.example");
      expect(json).not.toContain("destination.example");
      expect(json).not.toContain("cloneUrl");
      expect(json).not.toContain("userId");
      expect(json).not.toContain("sourceUrl");
    }
  });

  test("registers all read and sync tools", () => {
    const server = createMcpServer({ userId: "user-1", scopes: ["mirror:read", "mirror:sync", "mirror:settings"] });
    const registered = Object.keys((server as any)._registeredTools);
    expect(registered).toEqual(expect.arrayContaining([
      "list_repositories",
      "get_repository_status",
      "list_activities",
      "get_repository",
      "preview_tracked_repositories",
      "preview_repository_releases",
      "list_organizations",
      "get_organization",
      "preview_organization_repositories",
      "get_organization_mirror_overrides",
      "export_repositories",
      "export_organizations",
      "get_dashboard_summary",
      "get_provider_rate_limit",
      "list_starred_lists",
      "preview_organization_mirror_move",
      "get_mirror_configuration",
      "set_repository_status",
      "update_repository_settings",
      "update_repository_mirror_overrides",
      "delete_repositories",
      "update_organization_mirror_overrides",
      "set_organization_destination",
      "set_organization_source",
      "update_mirror_configuration",
      "delete_organization",
      "sync_repository",
      "retry_repository_sync",
      "sync_repositories",
      "mirror_repositories",
      "sync_organization",
      "mirror_organization",
      "reset_repository_metadata",
      "resolve_sync_alert",
      "set_organization_status_with_cascade",
      "move_repository_mirror",
      "move_organization_mirrors",
      "reconcile_destination",
      "import_repository",
      "import_organization",
      "refresh_repository_metadata",
      "update_schedule_configuration",
    ]));
    expect(registered).toHaveLength(42);
  });

  test("serves tools/list with JSON-Schema-compatible input schemas", async () => {
    const server = createMcpServer({ userId: "user-1", scopes: ["mirror:read"] });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }));
      const payload = await response.json() as {
        error?: { message?: string };
        result?: { tools?: Array<{ name: string }> };
      };
      expect(response.status).toBe(200);
      expect(payload.error).toBeUndefined();
      expect(payload.result?.tools?.map(({ name }) => name)).toContain("list_activities");
    } finally {
      await transport.close();
      await server.close();
    }
  });

  test("refuses a context without an authenticated user", () => {
    expect(() => createMcpServer({ userId: "" })).toThrow("requires a userId");
  });

  test("requires confirmation before organization move execution or reconciliation apply", async () => {
    const server = createMcpServer({ userId: "user-1", scopes: ["mirror:sync"], dispatchOperation: async () => { throw new Error("must not dispatch"); } });
    const tools = (server as any)._registeredTools;
    const move = await tools.move_organization_mirrors.handler({
      organizationId: "org-1", destinationOrg: "target", dryRun: false,
    });
    const reconcile = await tools.reconcile_destination.handler({
      dryRun: false, adoptUntracked: true,
    });
    const cascade = await tools.set_organization_status_with_cascade.handler({
      organizationId: "org-1", status: "ignored", cascade: true,
    });
    expect(move.structuredContent.error).toBe("Confirmation required");
    expect(reconcile.structuredContent.error).toBe("Confirmation required");
    expect(cascade.structuredContent.error).toBe("Confirmation required");
  });

  test("binds import dispatch to authenticated user and rejects missing confirmation on destructive actions", async () => {
    const calls: any[] = [];
    const server = createMcpServer({
      userId: "caller-1",
      scopes: ["mirror:sync", "mirror:settings"],
      dispatchOperation: async (input) => { calls.push(input); return { success: true, userId: "internal" }; },
    });
    const tools = (server as any)._registeredTools;
    await tools.import_repository.handler({ owner: "alice", repo: "project" });
    expect(calls[0]).toMatchObject({ userId: "caller-1", operation: "import-repository", body: { owner: "alice", repo: "project", force: false } });
    expect(calls).toHaveLength(1);
  });

  test("denies a destructive operation for a repository outside the caller scope", async () => {
    let dispatchCount = 0;
    const fakeDb: any = {
      select: () => {
        const query: any = {
          from: () => query,
          where: () => query,
          limit: async () => [],
        };
        return query;
      },
    };
    const server = createMcpServer({
      userId: "caller-1",
      scopes: ["mirror:settings"],
      db: fakeDb,
      dispatchOperation: async () => { dispatchCount += 1; return { success: true }; },
    });
    const response = await (server as any)._registeredTools.delete_repositories.handler({
      repositoryIds: ["other-user-repo"],
      confirm: true,
    });
    expect(response.structuredContent.error).toBe("Repository not found");
    expect(dispatchCount).toBe(0);
  });

  test("exposes only tools allowed by the granted OAuth scopes", () => {
    const readOnly = createMcpServer({ userId: "user-1", scopes: ["mirror:read"] });
    const syncOnly = createMcpServer({ userId: "user-1", scopes: ["mirror:sync"] });
    const settingsOnly = createMcpServer({ userId: "user-1", scopes: ["mirror:settings"] });
    expect(Object.keys((readOnly as any)._registeredTools)).toContain("get_dashboard_summary");
    expect(Object.keys((readOnly as any)._registeredTools)).not.toContain("sync_repository");
    expect(Object.keys((settingsOnly as any)._registeredTools)).toEqual(expect.arrayContaining([
      "set_repository_status",
      "delete_repositories",
      "update_mirror_configuration",
      "update_schedule_configuration",
    ]));
    expect(Object.keys((settingsOnly as any)._registeredTools)).not.toContain("sync_repository");
    expect(Object.keys((syncOnly as any)._registeredTools)).not.toContain("update_mirror_configuration");
    expect(Object.keys((syncOnly as any)._registeredTools)).not.toContain("update_schedule_configuration");
    expect(Object.keys((readOnly as any)._registeredTools)).not.toContain("delete_organization");
    expect(Object.keys((syncOnly as any)._registeredTools)).toEqual(expect.arrayContaining([
      "sync_repository",
      "retry_repository_sync",
      "sync_repositories",
      "mirror_repositories",
      "sync_organization",
      "mirror_organization",
      "move_repository_mirror",
      "move_organization_mirrors",
      "reconcile_destination",
      "import_repository",
      "import_organization",
      "refresh_repository_metadata",
    ]));
    expect(Object.keys((syncOnly as any)._registeredTools)).not.toContain("preview_connected_source_repositories");
  });
});

