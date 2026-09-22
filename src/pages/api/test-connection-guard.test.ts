/**
 * The two connection test routes make a server side request to a URL from
 * the request body. They were the only non-public API routes without an
 * auth guard (GHSA-9m33-xfrc-5jxw, GHSA-6m23-28hh-gjh2). Both now require a
 * signed in user and refuse link local and metadata addresses.
 *
 * Runs in an isolated child: the auth module is replaced here and bun's
 * mock.module is process wide.
 */

import { describe, test, expect, mock } from "bun:test";

const CHILD_FLAG = "GM_TEST_CONNECTION_GUARD_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("connection test routes (auth guard) - isolated child suite", () => {
    const res = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, [CHILD_FLAG]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) {
      console.error(res.stdout.toString());
      console.error(res.stderr.toString());
    }
    expect(res.exitCode).toBe(0);
  }, 60_000);
}

if (isChild) {
  // No session anywhere: the guard must answer 401 on its own.
  mock.module("@/lib/auth", () => ({
    auth: { api: { getSession: async () => null } },
  }));
}

const gitea = isChild ? await import("./gitea/test-connection") : ({} as any);
const github = isChild ? await import("./github/test-connection") : ({} as any);

function post(path: string, body: unknown, locals?: unknown) {
  return {
    request: new Request(`http://localhost/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: locals ?? {},
  } as any;
}

describe.skipIf(!isChild)("connection test routes", () => {
  const fetchCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify({ login: "someone" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  test("both routes answer 401 without a session and never fetch", async () => {
    const giteaResponse = await gitea.POST(
      post("gitea/test-connection", { url: "http://127.0.0.1:9999", token: "x" })
    );
    expect(giteaResponse.status).toBe(401);

    const githubResponse = await github.POST(
      post("github/test-connection", { provider: "gitea", url: "http://127.0.0.1:9999", token: "x" })
    );
    expect(githubResponse.status).toBe(401);
    expect(fetchCalls).toEqual([]);
  });

  test("a signed in user cannot point either route at the metadata service", async () => {
    const locals = { user: { id: "user-1" } };

    const giteaResponse = await gitea.POST(
      post("gitea/test-connection", { url: "http://169.254.169.254", token: "x" }, locals)
    );
    expect(giteaResponse.status).toBe(400);
    expect((await giteaResponse.json()).message).toMatch(/link local/);

    const githubResponse = await github.POST(
      post(
        "github/test-connection",
        { provider: "gitea", url: "http://169.254.169.254", token: "x" },
        locals
      )
    );
    expect(githubResponse.status).toBe(400);
    expect((await githubResponse.json()).message).toMatch(/link local/);
    expect(fetchCalls).toEqual([]);
  });

  test("a signed in user can still test a LAN Gitea", async () => {
    const response = await gitea.POST(
      post("gitea/test-connection", { url: "http://192.168.1.10:3000/", token: "x" }, {
        user: { id: "user-1" },
      })
    );
    expect(response.status).toBe(200);
    expect(fetchCalls[0]).toBe("http://192.168.1.10:3000/api/v1/user");
    globalThis.fetch = realFetch;
  });
});
