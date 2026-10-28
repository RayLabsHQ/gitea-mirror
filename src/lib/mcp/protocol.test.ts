import { describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION, SERVER_INSTRUCTIONS, handleMcpMessage } from "./protocol";
import { clientFor, rpc } from "./test-helpers";

const { client } = clientFor({});

describe("lifecycle", () => {
  test("initialize keeps a version it supports and offers tools", async () => {
    const response = await rpc(client, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(response?.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "gitea-mirror", title: "Gitea Mirror", version: "test" },
      instructions: SERVER_INSTRUCTIONS,
    });
  });

  test("initialize answers an unknown version with the newest it supports", async () => {
    const response = await rpc(client, "initialize", { protocolVersion: "2099-01-01" });
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  test("ping answers with an empty result", async () => {
    expect((await rpc(client, "ping"))?.result).toEqual({});
  });

  test("notifications and client responses get no answer", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, client, "t")).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 4, result: {} }, client, "t")).toBeNull();
  });

  test("tools work without an initialize first, since no session is kept", async () => {
    const response = await handleMcpMessage({ jsonrpc: "2.0", id: "a", method: "tools/list" }, client, "t");
    expect(response?.id).toBe("a");
    expect((response?.result as { tools: unknown[] }).tools).toHaveLength(8);
  });
});

describe("tools/list", () => {
  test("offers the eight tools, reads marked read only and nothing destructive", async () => {
    const response = await rpc(client, "tools/list");
    const tools = (response?.result as { tools: any[] }).tools;
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(Object.keys(byName).sort()).toEqual([
      "add_organization",
      "add_repository",
      "get_repository",
      "list_failures",
      "list_organizations",
      "list_repositories",
      "retry_repositories",
      "sync_repositories",
    ]);
    for (const name of ["list_repositories", "get_repository", "list_failures", "list_organizations"]) {
      expect(byName[name].annotations.readOnlyHint).toBe(true);
    }
    for (const name of ["add_repository", "add_organization", "sync_repositories", "retry_repositories"]) {
      expect(byName[name].annotations.readOnlyHint).toBe(false);
      expect(byName[name].annotations.destructiveHint).toBe(false);
    }
  });

  test("describes input as JSON Schema with defaults left optional", async () => {
    const response = await rpc(client, "tools/list");
    const tools = (response?.result as { tools: any[] }).tools;
    const add = tools.find((tool) => tool.name === "add_repository");
    expect(add.inputSchema.type).toBe("object");
    expect(add.inputSchema.$schema).toBeUndefined();
    expect(add.inputSchema.required).toEqual(["url"]);
    expect(add.inputSchema.properties.mirror).toMatchObject({ type: "boolean", default: true });

    const failures = tools.find((tool) => tool.name === "list_failures");
    expect(failures.inputSchema).toMatchObject({ type: "object", properties: {} });
  });
});

describe("errors", () => {
  test("an unknown method or tool is a protocol error", async () => {
    expect((await rpc(client, "resources/list"))?.error?.code).toBe(-32601);
    const unknownTool = await rpc(client, "tools/call", { name: "delete_everything", arguments: {} });
    expect(unknownTool?.error).toEqual({ code: -32602, message: "Unknown tool: delete_everything" });
  });

  test("bad arguments come back as a tool error the model can read", async () => {
    const response = await rpc(client, "tools/call", { name: "sync_repositories", arguments: { repositoryIds: [] } });
    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid arguments for sync_repositories: repositoryIds:");
  });

  test("malformed messages are refused", async () => {
    expect((await handleMcpMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }], client, "t"))?.error?.code).toBe(-32600);
    expect((await handleMcpMessage({ id: 1, method: "ping" }, client, "t"))?.error?.code).toBe(-32600);
    expect((await handleMcpMessage({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" }, client, "t"))?.error?.code).toBe(-32600);
    expect((await handleMcpMessage({ jsonrpc: "2.0", id: 1 }, client, "t"))?.error).toEqual({
      code: -32600,
      message: "The message has no method.",
    });
  });
});
