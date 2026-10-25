import { describe, expect, test } from "bun:test";
import { ALL, hasMcpToolScope, toMcpSyncResult } from "./mcp";

describe("POST /api/mcp", () => {
  test("accepts settings-only OAuth principals", () => {
    expect(hasMcpToolScope(["mirror:settings"])).toBe(true);
    expect(hasMcpToolScope(["openid"])).toBe(false);
  });
  test("rejects missing OAuth bearer credentials before creating an MCP session", async () => {
    const response = await ALL({
      request: new Request("http://localhost/api/mcp", { method: "POST" }),
    } as never);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("does not expose internal repository fields in queued sync results", () => {
    expect(toMcpSyncResult({
      message: "Sync job started.",
      repositories: [{
        id: "repo-1",
        name: "project",
        status: "syncing",
        userId: "private-user",
        cloneUrl: "https://secret.example/clone",
        mirrorOverrides: "{\"secret\":true}",
      }],
    })).toEqual({
      accepted: true,
      message: "Sync job started.",
      repositories: [{ id: "repo-1", name: "project", status: "syncing" }],
    });
  });
});
