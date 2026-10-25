import { describe, expect, test } from "bun:test";
import { createMcpServer, mcpLimitSchema, mcpRepositoryIdSchema } from "./server";

describe("MCP server registry", () => {
  test("validates bounded limits and repository identifiers", () => {
    expect(mcpLimitSchema.parse(undefined)).toBe(25);
    expect(mcpLimitSchema.safeParse(101).success).toBe(false);
    expect(mcpLimitSchema.safeParse(1.5).success).toBe(false);
    expect(mcpRepositoryIdSchema.safeParse("repo-1").success).toBe(true);
    expect(mcpRepositoryIdSchema.safeParse("  ").success).toBe(false);
    expect(mcpRepositoryIdSchema.safeParse("x".repeat(201)).success).toBe(false);
  });

  test("registers the five expected, user-bound tools", () => {
    const server = createMcpServer({ userId: "user-1" });
    const registered = Object.keys((server as any)._registeredTools);
    expect(registered).toEqual(expect.arrayContaining([
      "list_repositories",
      "get_repository_status",
      "list_activities",
      "sync_repository",
      "retry_repository_sync",
    ]));
    expect(registered).toHaveLength(5);
  });

  test("refuses a context without an authenticated user", () => {
    expect(() => createMcpServer({ userId: "" })).toThrow("requires a userId");
  });

  test("exposes only tools allowed by the granted OAuth scopes", () => {
    const readOnly = createMcpServer({ userId: "user-1", scopes: ["mirror:read"] });
    const syncOnly = createMcpServer({ userId: "user-1", scopes: ["mirror:sync"] });
    expect(Object.keys((readOnly as any)._registeredTools)).toHaveLength(3);
    expect(Object.keys((syncOnly as any)._registeredTools)).toEqual([
      "sync_repository",
      "retry_repository_sync",
    ]);
  });
});

