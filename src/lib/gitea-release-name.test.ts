/**
 * Regression test for #334 — "Release titles not being mirrored properly".
 *
 * Root cause: the release create/update payloads sent `title:` to Gitea's release
 * API, but Gitea/Forgejo expose the release title as the JSON field `name`
 * (the Go struct is `Title string ` + backtick + `json:"name"` + backtick + `).
 * `title` is silently ignored, so every mirrored release landed with a blank name.
 *
 * These tests drive the real `mirrorGitHubReleasesToGitea` with a mocked `fetch`
 * and assert that the outgoing payload carries `name` (and NOT `title`) on both the
 * create path and the update path. Verified live against Gitea 1.24.7: a POST with
 * `title` yields `name: ""`, a POST with `name` yields the correct title.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mirrorGitHubReleasesToGitea } from "@/lib/gitea";
import { createMockResponse } from "@/tests/mock-fetch";

const GITEA_URL = "http://gitea.local";

const baseConfig = {
  userId: "user-1",
  giteaConfig: {
    url: GITEA_URL,
    token: "gitea-token-plaintext",
    defaultOwner: "tester",
    releaseLimit: 10,
  },
} as any;

const repository = {
  id: "repo-1",
  name: "reltest",
  owner: "tester",
  fullName: "tester/reltest",
} as any;

// A GitHub release whose human-facing title ("v0.19.0") differs from nothing —
// the exact shape from the issue: name is the title shown in the UI.
const githubRelease = {
  tag_name: "v0.19.0",
  name: "v0.19.0",
  body: "## Features\n- something",
  draft: false,
  prerelease: false,
  created_at: "2026-06-28T07:44:41Z",
  published_at: "2026-06-28T07:46:23Z",
  assets: [],
};

function makeOctokit() {
  return {
    rest: {
      repos: {
        listReleases: async () => ({ data: [githubRelease] }),
      },
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

describe("mirrorGitHubReleasesToGitea — release title (#334)", () => {
  test("CREATE path sends the release title as `name`, never `title`", async () => {
    let createBody: any = null;

    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      const method = options?.method || "GET";

      // POST /releases — the release creation call we're asserting on.
      if (method === "POST" && url.endsWith("/releases")) {
        createBody = JSON.parse(String(options!.body));
        return createMockResponse({ id: 1 }, { status: 201 });
      }
      // GET /releases/tags/<tag> — release does not exist yet -> create path.
      if (url.includes("/releases/tags/")) {
        return createMockResponse({ message: "Not Found" }, { ok: false, status: 404 });
      }
      // GET /tags/<tag> — the git tag exists in Gitea (mirror already synced it).
      if (url.includes("/tags/")) {
        return createMockResponse({ name: "v0.19.0" }, { status: 200 });
      }
      // GET /repos/<owner>/<repo> — repo-exists probe.
      return createMockResponse({ id: 1, name: "reltest" }, { status: 200 });
    }) as any;

    await mirrorGitHubReleasesToGitea({
      octokit: makeOctokit(),
      repository,
      config: baseConfig,
      giteaOwner: "tester",
      giteaRepoName: "reltest",
    });

    expect(createBody).not.toBeNull();
    expect(createBody.name).toBe("v0.19.0");
    expect(createBody).not.toHaveProperty("title");
    expect(createBody.tag_name).toBe("v0.19.0");
  });

  test("UPDATE path sends the release title as `name`, never `title`", async () => {
    let patchBody: any = null;

    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      const method = options?.method || "GET";

      // PATCH /releases/<id> — the update call we're asserting on.
      if (method === "PATCH" && url.includes("/releases/")) {
        patchBody = JSON.parse(String(options!.body));
        return createMockResponse({ id: 5 }, { status: 200 });
      }
      // GET /releases/tags/<tag> — release ALREADY exists, but with a blank name
      // (the previously-broken state). Its differing name must trigger a PATCH.
      if (method === "GET" && url.includes("/releases/tags/")) {
        return createMockResponse(
          { id: 5, name: "", body: "stale" },
          { status: 200 }
        );
      }
      // GET /releases/<id>/assets — asset reconciliation probe (empty).
      if (url.includes("/assets")) {
        return createMockResponse([], { status: 200 });
      }
      // GET /repos/<owner>/<repo> — repo-exists probe.
      return createMockResponse({ id: 1, name: "reltest" }, { status: 200 });
    }) as any;

    await mirrorGitHubReleasesToGitea({
      octokit: makeOctokit(),
      repository,
      config: baseConfig,
      giteaOwner: "tester",
      giteaRepoName: "reltest",
    });

    expect(patchBody).not.toBeNull();
    expect(patchBody.name).toBe("v0.19.0");
    expect(patchBody).not.toHaveProperty("title");
  });

  test("falls back to tag_name as the release name when GitHub release name is empty", async () => {
    let createBody: any = null;

    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      const method = options?.method || "GET";
      if (method === "POST" && url.endsWith("/releases")) {
        createBody = JSON.parse(String(options!.body));
        return createMockResponse({ id: 2 }, { status: 201 });
      }
      if (url.includes("/releases/tags/")) {
        return createMockResponse({ message: "Not Found" }, { ok: false, status: 404 });
      }
      if (url.includes("/tags/")) {
        return createMockResponse({ name: "v1.2.3" }, { status: 200 });
      }
      return createMockResponse({ id: 1, name: "reltest" }, { status: 200 });
    }) as any;

    const octokit = {
      rest: {
        repos: {
          listReleases: async () => ({
            data: [{ ...githubRelease, tag_name: "v1.2.3", name: null }],
          }),
        },
      },
    } as any;

    await mirrorGitHubReleasesToGitea({
      octokit,
      repository,
      config: baseConfig,
      giteaOwner: "tester",
      giteaRepoName: "reltest",
    });

    expect(createBody).not.toBeNull();
    expect(createBody.name).toBe("v1.2.3");
  });
});
