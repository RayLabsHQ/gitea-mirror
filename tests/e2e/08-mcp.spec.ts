/**
 * 08 – Read only API keys and the MCP server.
 *
 * Creates a full access key and a read only key, checks that the read only
 * key can read but every change is refused, then starts the MCP server from
 * mcp/dist (the workflow builds it) over stdio with each key and calls its
 * tools against the repositories the earlier specs mirrored.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_URL, getAppSessionCookies } from "./helpers";

const KEY_HEADER = "x-api-key";
const MCP_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../../mcp/dist/index.js");

async function createKey(
  request: APIRequestContext,
  cookies: string,
  name: string,
  metadata?: Record<string, unknown>
): Promise<{ id: string; key: string }> {
  const resp = await request.post(`${APP_URL}/api/auth/api-key/create`, {
    headers: { Cookie: cookies, Origin: APP_URL, "Content-Type": "application/json" },
    data: { name, ...(metadata ? { metadata } : {}) },
    failOnStatusCode: false,
  });
  expect(resp.status(), await resp.text()).toBe(200);
  const body = await resp.json();
  return { id: body.id, key: body.key };
}

/** A line-delimited JSON-RPC session with the MCP server over stdio. */
class McpSession {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  stderr = "";

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  static async start(apiKey: string): Promise<McpSession> {
    const child = spawn("node", [MCP_ENTRY], {
      env: { ...process.env, GITEA_MIRROR_URL: APP_URL, GITEA_MIRROR_API_KEY: apiKey },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session = new McpSession(child);
    const init = await session.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0.0.0" },
    });
    expect(init.result?.serverInfo?.name, session.stderr).toBe("gitea-mirror");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return session;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr: ${this.stderr}`)), 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    const message = await this.request("tools/call", { name, arguments: args });
    expect(message.error, JSON.stringify(message.error)).toBeUndefined();
    const text: string = message.result.content[0]?.text ?? "";
    const isError = message.result.isError === true;
    return { isError, text, data: isError ? undefined : JSON.parse(text) };
  }

  stop(): void {
    this.child.kill();
  }
}

test.describe("E2E: read only keys and the MCP server", () => {
  let cookies = "";
  let fullKey = { id: "", key: "" };
  let readKey = { id: "", key: "" };
  let mirrored: { id: string; fullName: string } | null = null;

  test("Step 1: create a full access key and a read only key", async ({ request }) => {
    cookies = await getAppSessionCookies(request);
    expect(cookies).toBeTruthy();
    fullKey = await createKey(request, cookies, "e2e-mcp-full");
    readKey = await createKey(request, cookies, "e2e-mcp-read", { access: "read" });
    expect(fullKey.key.startsWith("gm_")).toBeTruthy();
    expect(readKey.key.startsWith("gm_")).toBeTruthy();

    const list = await request.get(`${APP_URL}/api/auth/api-key/list`, { headers: { Cookie: cookies } });
    const rows = (await list.json()).apiKeys as Array<{ id: string; metadata?: unknown }>;
    expect(rows.find((row) => row.id === readKey.id)?.metadata).toEqual({ access: "read" });
  });

  test("Step 2: the read only key reads but cannot change anything", async ({ request }) => {
    const repos = await request.get(`${APP_URL}/api/github/repositories`, {
      headers: { [KEY_HEADER]: readKey.key },
    });
    expect(repos.status()).toBe(200);
    const tracked = ((await repos.json()).repositories ?? []) as Array<{ id: string; fullName: string; status: string }>;
    const found = tracked.find((repo) => repo.status === "mirrored" || repo.status === "synced");
    expect(found, "spec 02 leaves at least one mirrored repository").toBeTruthy();
    mirrored = { id: found!.id, fullName: found!.fullName };

    const session = await request.get(`${APP_URL}/api/auth/get-session`, {
      headers: { [KEY_HEADER]: readKey.key },
    });
    expect(session.status()).toBe(200);

    const sync = await request.post(`${APP_URL}/api/job/sync-repo`, {
      headers: { [KEY_HEADER]: readKey.key, "Content-Type": "application/json" },
      data: { repositoryIds: [mirrored.id] },
      failOnStatusCode: false,
    });
    expect(sync.status()).toBe(403);
    expect((await sync.json()).code).toBe("API_KEY_READ_ONLY");

    const patch = await request.patch(`${APP_URL}/api/repositories/${mirrored.id}`, {
      headers: { [KEY_HEADER]: readKey.key, "Content-Type": "application/json" },
      data: { destinationOrg: "should-not-stick" },
      failOnStatusCode: false,
    });
    expect(patch.status()).toBe(403);

    const after = await request.get(`${APP_URL}/api/repositories/${mirrored.id}`, {
      headers: { [KEY_HEADER]: readKey.key },
    });
    expect((await after.json()).repository.destinationOrg ?? null).not.toBe("should-not-stick");
  });

  test("Step 3: the MCP server lists, finds and syncs with the full key", async () => {
    expect(existsSync(MCP_ENTRY), `build the MCP server first: ${MCP_ENTRY}`).toBe(true);
    const mcp = await McpSession.start(fullKey.key);
    try {
      const { result } = await mcp.request("tools/list");
      expect(result.tools).toHaveLength(8);

      const list = await mcp.callTool("list_repositories", { limit: 200 });
      expect(list.isError, list.text).toBe(false);
      expect(list.data.total).toBeGreaterThan(0);
      expect(list.data.repositories.some((repo: { id: string }) => repo.id === mirrored!.id)).toBe(true);

      const one = await mcp.callTool("get_repository", { repository: mirrored!.fullName });
      expect(one.isError, one.text).toBe(false);
      expect(one.data.repository.id).toBe(mirrored!.id);
      expect(Array.isArray(one.data.recentActivity)).toBe(true);

      const failures = await mcp.callTool("list_failures");
      expect(failures.isError, failures.text).toBe(false);
      expect(typeof failures.data.count).toBe("number");

      const orgs = await mcp.callTool("list_organizations");
      expect(orgs.isError, orgs.text).toBe(false);

      // Adding a repository that is already tracked hands back the same row.
      const again = await mcp.callTool("add_repository", { url: mirrored!.fullName });
      expect(again.isError, again.text).toBe(false);
      expect(again.data.added).toBe(false);
      expect(again.data.repository.id).toBe(mirrored!.id);

      const sync = await mcp.callTool("sync_repositories", { repositoryIds: [mirrored!.id] });
      expect(sync.isError, sync.text).toBe(false);
      expect(sync.data.repositories.map((repo: { id: string }) => repo.id)).toContain(mirrored!.id);
    } finally {
      mcp.stop();
    }
  });

  test("Step 4: through MCP the read only key reads and is refused on sync", async () => {
    const mcp = await McpSession.start(readKey.key);
    try {
      const list = await mcp.callTool("list_repositories");
      expect(list.isError, list.text).toBe(false);

      const sync = await mcp.callTool("sync_repositories", { repositoryIds: [mirrored!.id] });
      expect(sync.isError).toBe(true);
      expect(sync.text).toContain("read only");
    } finally {
      mcp.stop();
    }
  });

  test("Step 5: revoke both keys", async ({ request }) => {
    for (const key of [fullKey, readKey]) {
      const resp = await request.post(`${APP_URL}/api/auth/api-key/delete`, {
        headers: { Cookie: cookies, Origin: APP_URL, "Content-Type": "application/json" },
        data: { keyId: key.id },
        failOnStatusCode: false,
      });
      expect(resp.status(), await resp.text()).toBe(200);
    }
  });
});
