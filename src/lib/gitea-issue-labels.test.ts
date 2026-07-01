/**
 * Regression test for the #334 sibling bug — labels silently dropped on issue update.
 *
 * Gitea/Forgejo's `EditIssueOption` has no `labels` field (only `CreateIssueOption`
 * does), so a `labels` key in a `PATCH .../issues/{index}` body is silently ignored.
 * The old code sent `labels` in the update PATCH, so label changes never propagated
 * onto already-mirrored issues. The fix reconciles labels through the dedicated
 * sub-resource `PUT .../issues/{index}/labels`.
 *
 * Verified live against Gitea 1.24.7: PATCH with `labels` leaves the issue's labels
 * unchanged; PUT to the labels sub-resource replaces them.
 *
 * This test drives the real `mirrorGitRepoIssuesToGitea` with a mocked `fetch` and a
 * stub Octokit, and asserts (a) the update PATCH body carries NO `labels` key, and
 * (b) a `PUT .../issues/{n}/labels` is made with the resolved Gitea label IDs.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Other test files (e.g. gitea-enhanced.test.ts) install a process-global
// `mock.module("@/lib/http-client", ...)` whose fake `httpGet` throws 404 for any
// repo it doesn't recognize and omits `httpPut`. That leaks across files in bun's
// shared module registry and would hijack this test's fetch chain. Re-register a
// faithful, `fetch`-delegating http-client here so this test drives its own
// `globalThis.fetch` mock regardless of evaluation order.
mock.module("@/lib/http-client", () => {
  class HttpError extends Error {
    status: number;
    statusText: string;
    response?: string;
    constructor(message: string, status: number, statusText: string, response?: string) {
      super(message);
      this.name = "HttpError";
      this.status = status;
      this.statusText = statusText;
      this.response = response;
    }
  }
  async function request(url: string, options: RequestInit) {
    const res = await globalThis.fetch(url as any, options);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(`HTTP ${res.status}: ${res.statusText}`, res.status, res.statusText, text);
    }
    const contentType = res.headers.get("content-type");
    const data = contentType && contentType.includes("application/json")
      ? await res.json()
      : await res.text();
    return { data, status: res.status, statusText: res.statusText, headers: res.headers };
  }
  return {
    HttpError,
    httpGet: (url: string, headers?: Record<string, string>) =>
      request(url, { method: "GET", headers }),
    httpPost: (url: string, body?: any, headers?: Record<string, string>) =>
      request(url, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined }),
    httpPut: (url: string, body?: any, headers?: Record<string, string>) =>
      request(url, { method: "PUT", headers, body: body ? JSON.stringify(body) : undefined }),
    httpPatch: (url: string, body?: any, headers?: Record<string, string>) =>
      request(url, { method: "PATCH", headers, body: body ? JSON.stringify(body) : undefined }),
    httpDelete: (url: string, headers?: Record<string, string>) =>
      request(url, { method: "DELETE", headers }),
  };
});

import { mirrorGitRepoIssuesToGitea } from "@/lib/gitea";
import { createMockResponse } from "@/tests/mock-fetch";

const GITEA_URL = "http://gitea.local";

const baseConfig = {
  userId: "user-1",
  githubConfig: { token: "gh-token-plaintext", owner: "tester" },
  giteaConfig: {
    url: GITEA_URL,
    token: "gitea-token-plaintext",
    defaultOwner: "tester",
    issueConcurrency: 1,
  },
} as any;

const repository = {
  id: "repo-1",
  name: "reltest",
  owner: "tester",
  fullName: "tester/reltest",
} as any;

// Octokit stub: identifies paginate targets by sentinel and returns fixtures.
function makeOctokit(githubIssue: any) {
  return {
    rest: {
      issues: {
        listForRepo: "LIST_FOR_REPO",
        listComments: "LIST_COMMENTS",
      },
    },
    paginate: async (method: any) => {
      if (method === "LIST_FOR_REPO") return [githubIssue];
      return []; // no comments
    },
  } as any;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mirrorGitRepoIssuesToGitea — labels on update (#334 sibling)", () => {
  test("update path omits `labels` from the PATCH and reconciles via PUT /labels", async () => {
    let patchBody: any = null;
    let putBody: any = null;
    let putUrl: string | null = null;

    // Existing Gitea issue already mirrored for GitHub #1 -> triggers the update path.
    const existingGiteaIssue = {
      number: 101,
      title: "[GH-ISSUE #1] Fix the thing",
      body: "stale body",
    };

    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      const method = options?.method || "GET";

      if (method === "PUT" && url.includes("/labels")) {
        putUrl = url;
        putBody = JSON.parse(String(options!.body));
        return createMockResponse([], { status: 200 });
      }
      if (method === "PATCH" && url.includes("/issues/")) {
        patchBody = JSON.parse(String(options!.body));
        return createMockResponse({ number: 101 }, { status: 200 });
      }
      if (method === "GET" && url.includes("/issues?state=all&page=")) {
        return createMockResponse([existingGiteaIssue], { status: 200 });
      }
      if (method === "GET" && url.endsWith("/labels")) {
        return createMockResponse([{ name: "bug", id: 7 }], { status: 200 });
      }
      // repo-exists probe (raw fetch reads .ok) and any other call
      return createMockResponse({ id: 1 }, { status: 200 });
    }) as any;

    const githubIssue = {
      number: 1,
      title: "Fix the thing",
      body: "desc",
      state: "open",
      html_url: "https://github.com/tester/reltest/issues/1",
      labels: [{ name: "bug" }],
      user: { login: "octo" },
    };

    await mirrorGitRepoIssuesToGitea({
      octokit: makeOctokit(githubIssue),
      repository,
      config: baseConfig,
      giteaOwner: "tester",
      giteaRepoName: "reltest",
    });

    // (a) the PATCH must NOT try to set labels (Gitea ignores it)
    expect(patchBody).not.toBeNull();
    expect(patchBody).not.toHaveProperty("labels");

    // (b) labels reconciled via the sub-resource with the resolved Gitea label id
    expect(putUrl).toBe(`${GITEA_URL}/api/v1/repos/tester/reltest/issues/101/labels`);
    expect(putBody).toEqual({ labels: [7] });
  });

  test("reconciles to an empty set when the GitHub issue has no labels (removal propagates)", async () => {
    let putBody: any = null;

    const existingGiteaIssue = {
      number: 202,
      title: "[GH-ISSUE #2] No labels now",
      body: "stale",
    };

    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      const method = options?.method || "GET";
      if (method === "PUT" && url.includes("/labels")) {
        putBody = JSON.parse(String(options!.body));
        return createMockResponse([], { status: 200 });
      }
      if (method === "PATCH" && url.includes("/issues/")) {
        return createMockResponse({ number: 202 }, { status: 200 });
      }
      if (method === "GET" && url.includes("/issues?state=all&page=")) {
        return createMockResponse([existingGiteaIssue], { status: 200 });
      }
      if (method === "GET" && url.endsWith("/labels")) {
        return createMockResponse([{ name: "bug", id: 7 }], { status: 200 });
      }
      return createMockResponse({ id: 1 }, { status: 200 });
    }) as any;

    const githubIssue = {
      number: 2,
      title: "No labels now",
      body: "desc",
      state: "open",
      html_url: "https://github.com/tester/reltest/issues/2",
      labels: [], // upstream removed all labels
      user: { login: "octo" },
    };

    await mirrorGitRepoIssuesToGitea({
      octokit: makeOctokit(githubIssue),
      repository,
      config: baseConfig,
      giteaOwner: "tester",
      giteaRepoName: "reltest",
    });

    expect(putBody).toEqual({ labels: [] });
  });
});
