/**
 * The GitHub and GitLab target adapters against a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GitHubPushTarget, githubApiRootFor } from "./github";
import { GitLabPushTarget } from "./gitlab";
import { createPushTarget } from "./index";
import { PushTargetError } from "./types";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let routes: Array<{ method: string; test: (url: string) => boolean; reply: (call: Call) => Response }> = [];
const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function on(method: string, matcher: string | RegExp, reply: (call: Call) => Response) {
  routes.push({
    method,
    test: (url) => (typeof matcher === "string" ? url === matcher : matcher.test(url)),
    reply,
  });
}

beforeEach(() => {
  calls = [];
  routes = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, url, headers, body };
    calls.push(call);
    const route = routes.find((r) => r.method === method && r.test(url));
    if (!route) return jsonResponse({ message: `no route for ${method} ${url}` }, 404);
    return route.reply(call);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHub push target", () => {
  const target = new GitHubPushTarget({ url: "https://github.com", username: "octocat", token: "gh-secret" });

  test("uses api.github.com for github.com and /api/v3 for an enterprise host", () => {
    expect(githubApiRootFor("https://github.com")).toBe("https://api.github.com");
    expect(githubApiRootFor("https://ghe.example.com/")).toBe("https://ghe.example.com/api/v3");
  });

  test("testConnection returns the token's login and sends the bearer token", async () => {
    on("GET", "https://api.github.com/user", () => jsonResponse({ login: "octocat" }));
    const identity = await target.testConnection();
    expect(identity.login).toBe("octocat");
    expect(calls[0].headers.authorization).toBe("Bearer gh-secret");
  });

  test("ensureRepository returns an existing repository without creating one", async () => {
    on("GET", "https://api.github.com/repos/octocat/tool", () =>
      jsonResponse({ name: "tool", owner: { login: "octocat" }, private: true, archived: false, clone_url: "https://github.com/octocat/tool.git", html_url: "https://github.com/octocat/tool" })
    );
    const repo = await target.ensureRepository({ owner: "octocat", name: "tool", isPrivate: true });
    expect(repo.created).toBe(false);
    expect(repo.pushUrl).toBe("https://github.com/octocat/tool.git");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("ensureRepository creates under the user when the owner is the token's account", async () => {
    on("GET", "https://api.github.com/repos/Octocat/tool", () => jsonResponse({ message: "Not Found" }, 404));
    on("POST", "https://api.github.com/user/repos", (call) =>
      jsonResponse({ name: "tool", owner: { login: "octocat" }, private: call.body && (call.body as { private: boolean }).private, clone_url: "https://github.com/octocat/tool.git" })
    );
    const repo = await target.ensureRepository({ owner: "Octocat", name: "tool", isPrivate: true, description: "d" });
    expect(repo.created).toBe(true);
    expect(repo.isPrivate).toBe(true);
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.body).toMatchObject({ name: "tool", private: true, has_issues: false, auto_init: false });
  });

  test("ensureRepository creates under the organization otherwise, and explains a missing one", async () => {
    on("GET", "https://api.github.com/repos/acme/tool", () => jsonResponse({}, 404));
    on("POST", "https://api.github.com/orgs/acme/repos", () =>
      jsonResponse({ name: "tool", owner: { login: "acme" }, clone_url: "https://github.com/acme/tool.git" })
    );
    const repo = await target.ensureRepository({ owner: "acme", name: "tool", isPrivate: false });
    expect(repo.owner).toBe("acme");
    expect(repo.created).toBe(true);

    calls = [];
    routes = [];
    on("GET", "https://api.github.com/repos/missing/tool", () => jsonResponse({}, 404));
    on("POST", "https://api.github.com/orgs/missing/repos", () => jsonResponse({ message: "Not Found" }, 404));
    await expect(target.ensureRepository({ owner: "missing", name: "tool", isPrivate: false })).rejects.toThrow(
      /organization "missing" was not found/
    );
  });

  test("a 422 on create re-reads the repository (lost race)", async () => {
    let reads = 0;
    on("GET", "https://api.github.com/repos/octocat/tool", () => {
      reads += 1;
      return reads === 1 ? jsonResponse({}, 404) : jsonResponse({ name: "tool", owner: { login: "octocat" }, clone_url: "u" });
    });
    on("POST", "https://api.github.com/user/repos", () => jsonResponse({ message: "name already exists" }, 422));
    const repo = await target.ensureRepository({ owner: "octocat", name: "tool", isPrivate: false });
    expect(repo.created).toBe(false);
  });

  test("archive patches archived, delete explains a missing scope and tolerates 404", async () => {
    on("PATCH", "https://api.github.com/repos/octocat/tool", () => jsonResponse({ archived: true }));
    await target.archiveRepository("octocat", "tool");
    expect(calls[0].body).toEqual({ archived: true });

    on("DELETE", "https://api.github.com/repos/octocat/tool", () => jsonResponse({ message: "Must have admin rights" }, 403));
    await expect(target.deleteRepository("octocat", "tool")).rejects.toThrow(/delete_repo/);

    routes = [];
    on("DELETE", "https://api.github.com/repos/octocat/gone", () => jsonResponse({}, 404));
    await expect(target.deleteRepository("octocat", "gone")).resolves.toBeUndefined();
  });

  test("push credentials use the account name and the token", () => {
    expect(target.pushCredentials()).toEqual({ username: "octocat", token: "gh-secret" });
    expect(new GitHubPushTarget({ url: "https://github.com", username: "", token: "t" }).pushCredentials().username).toBe(
      "x-access-token"
    );
  });
});

describe("GitLab push target", () => {
  const target = new GitLabPushTarget({ url: "https://gitlab.com", username: "jane", token: "gl-secret" });

  test("testConnection sends the private token and reads the username", async () => {
    on("GET", "https://gitlab.com/api/v4/user", () => jsonResponse({ username: "jane" }));
    on("GET", "https://gitlab.com/api/v4/version", () => jsonResponse({ version: "17.4.0" }));
    const identity = await target.testConnection();
    expect(identity).toEqual({ login: "jane", label: "GitLab 17.4.0" });
    expect(calls[0].headers["private-token"]).toBe("gl-secret");
  });

  test("ensureRepository looks projects up by encoded path and creates them in a group", async () => {
    on("GET", "https://gitlab.com/api/v4/projects/acme%2Ftool", () => jsonResponse({ message: "404 Project Not Found" }, 404));
    on("GET", "https://gitlab.com/api/v4/namespaces/acme", () => jsonResponse({ id: 42, full_path: "acme", kind: "group" }));
    on("POST", "https://gitlab.com/api/v4/projects", (call) =>
      jsonResponse({
        id: 7,
        name: "tool",
        path: "tool",
        namespace: { full_path: "acme" },
        visibility: (call.body as { visibility: string }).visibility,
        http_url_to_repo: "https://gitlab.com/acme/tool.git",
        web_url: "https://gitlab.com/acme/tool",
      })
    );
    const repo = await target.ensureRepository({ owner: "acme", name: "tool", isPrivate: true });
    expect(repo.created).toBe(true);
    expect(repo.isPrivate).toBe(true);
    expect(repo.pushUrl).toBe("https://gitlab.com/acme/tool.git");
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.body).toMatchObject({ name: "tool", path: "tool", namespace_id: 42, visibility: "private" });
  });

  test("a missing top level group is created; a missing nested group is not", async () => {
    on("GET", "https://gitlab.com/api/v4/projects/newgroup%2Ftool", () => jsonResponse({}, 404));
    on("GET", "https://gitlab.com/api/v4/namespaces/newgroup", () => jsonResponse({}, 404));
    on("POST", "https://gitlab.com/api/v4/groups", () => jsonResponse({ id: 99, full_path: "newgroup" }));
    on("POST", "https://gitlab.com/api/v4/projects", () =>
      jsonResponse({ id: 8, name: "tool", path: "tool", namespace: { full_path: "newgroup" }, http_url_to_repo: "u", web_url: "w" })
    );
    const repo = await target.ensureRepository({ owner: "newgroup", name: "tool", isPrivate: false });
    expect(repo.created).toBe(true);
    expect(calls.find((c) => c.url.endsWith("/groups"))!.body).toMatchObject({ path: "newgroup", visibility: "private" });

    routes = [];
    on("GET", "https://gitlab.com/api/v4/projects/parent%2Fchild%2Ftool", () => jsonResponse({}, 404));
    on("GET", "https://gitlab.com/api/v4/namespaces/parent%2Fchild", () => jsonResponse({}, 404));
    await expect(target.ensureRepository({ owner: "parent/child", name: "tool", isPrivate: false })).rejects.toThrow(
      /Nested groups are not created automatically/
    );
  });

  test("projects under the token's own user need no namespace lookup", async () => {
    on("GET", "https://gitlab.com/api/v4/projects/jane%2Ftool", () => jsonResponse({}, 404));
    on("POST", "https://gitlab.com/api/v4/projects", () =>
      jsonResponse({ id: 9, name: "tool", path: "tool", namespace: { full_path: "jane" }, http_url_to_repo: "u", web_url: "w" })
    );
    await target.ensureRepository({ owner: "jane", name: "tool", isPrivate: false });
    expect(calls.some((c) => c.url.includes("/namespaces/"))).toBe(false);
    expect((calls.find((c) => c.method === "POST")!.body as { namespace_id?: number }).namespace_id).toBeUndefined();
  });

  test("archive posts to /archive and delete tolerates a missing project", async () => {
    on("POST", "https://gitlab.com/api/v4/projects/acme%2Ftool/archive", () => jsonResponse({ archived: true }));
    await target.archiveRepository("acme", "tool");
    on("DELETE", "https://gitlab.com/api/v4/projects/acme%2Fgone", () => jsonResponse({}, 404));
    await expect(target.deleteRepository("acme", "gone")).resolves.toBeUndefined();
    on("DELETE", "https://gitlab.com/api/v4/projects/acme%2Flocked", () => jsonResponse({ message: "403 Forbidden" }, 403));
    await expect(target.deleteRepository("acme", "locked")).rejects.toBeInstanceOf(PushTargetError);
  });

  test("push credentials use the oauth2 user", () => {
    expect(target.pushCredentials()).toEqual({ username: "oauth2", token: "gl-secret" });
  });

  test("a project waiting in delayed deletion, or reached through a renamed path, counts as missing", async () => {
    on("GET", "https://gitlab.com/api/v4/projects/acme%2Fold", () =>
      jsonResponse({ id: 1, name: "old", path: "old", path_with_namespace: "acme/old", marked_for_deletion_at: "2026-09-02" })
    );
    expect(await target.getRepository("acme", "old")).toBeNull();
    on("GET", "https://gitlab.com/api/v4/projects/acme%2Fmoved", () =>
      jsonResponse({ id: 2, name: "moved", path: "moved-deletion_scheduled-1", path_with_namespace: "acme/moved-deletion_scheduled-1" })
    );
    expect(await target.getRepository("acme", "moved")).toBeNull();
    on("GET", "https://gitlab.com/api/v4/projects/acme%2Flive", () =>
      jsonResponse({ id: 3, name: "live", path: "live", path_with_namespace: "acme/live" })
    );
    expect((await target.getRepository("acme", "live"))?.name).toBe("live");
  });
});

describe("createPushTarget", () => {
  test("builds the adapter for each kind", () => {
    expect(createPushTarget("github", { url: "https://github.com", username: "u", token: "t" }).kind).toBe("github");
    expect(createPushTarget("gitlab", { url: "https://gitlab.com", username: "u", token: "t" }).kind).toBe("gitlab");
  });
});
