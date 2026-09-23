/**
 * Behavioural tests for incremental issue and pull request sync (#449).
 *
 * With a watermark from a completed pass, the GitHub listing is asked only
 * for what changed (`since`), and the per-issue comment listing and per-PR
 * detail, commits and files calls run only for the items that came back.
 * Without one, the pass is full and unchanged from before.
 *
 * The destination is a fake global fetch and GitHub is a fake Octokit. Other
 * test files replace @/lib/http-client and friends with mock.module, which is
 * process wide in bun and depends on file order, so the suites run in an
 * isolated child process (same harness as gitea-source-releases.test.ts).
 */

import { afterEach, describe, expect, it, test } from "bun:test";
import type { Config } from "@/types/config";
import type { Repository } from "@/lib/db/schema";
import type { MetadataSyncCursor } from "@/lib/metadata-state";

const CHILD_FLAG = "GM_INCREMENTAL_METADATA_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("incremental metadata sync - isolated child suite", () => {
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

const { mirrorGitRepoIssuesToGitea, mirrorGitRepoPullRequestsToGitea } = isChild
  ? await import("@/lib/gitea")
  : ({} as typeof import("@/lib/gitea"));
const { INCREMENTAL_SYNC_SAFETY_MARGIN_MS } = isChild
  ? await import("@/lib/metadata-state")
  : ({} as typeof import("@/lib/metadata-state"));

const GITEA_URL = "https://gitea.example.com";
const DEST_OWNER = "mirror-owner";
const DEST_REPO = "demo";
const DEST_API = `${GITEA_URL}/api/v1/repos/${DEST_OWNER}/${DEST_REPO}`;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const config = {
  userId: "user-1",
  githubConfig: { owner: "acme", token: "github-token" },
  giteaConfig: {
    url: GITEA_URL,
    token: "gitea-token",
    defaultOwner: DEST_OWNER,
    issueConcurrency: 1,
    pullRequestConcurrency: 1,
  },
} as unknown as Partial<Config>;

const repository = {
  id: "repo-1",
  name: DEST_REPO,
  fullName: "acme/demo",
  owner: "acme",
  isStarred: false,
  mirrorOverrides: null,
  organization: null,
} as unknown as Repository;

interface Recorded {
  method: string;
  url: string;
  body?: string;
}

/** Destination Gitea with a fixed set of issues already present. */
function fakeGitea(existingIssues: Array<{ number: number; title: string }>) {
  const requests: Recorded[] = [];
  let nextNumber = 1000;

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url, body });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "GET" && url === DEST_API) return json({ id: 1, name: DEST_REPO });
    if (method === "GET" && url === `${DEST_API}/labels`) return json([]);
    if (method === "POST" && url === `${DEST_API}/labels`) return json({ id: 7 }, 201);
    if (method === "GET" && url.startsWith(`${DEST_API}/issues?`)) {
      // The defensive recheck searches by marker; nothing to recover.
      if (url.includes("&q=")) return json([]);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return json(
        page === 1
          ? existingIssues.map((issue) => ({ ...issue, body: "", state: "open" }))
          : []
      );
    }
    if (method === "POST" && url === `${DEST_API}/issues`) {
      nextNumber += 1;
      return json({ number: nextNumber, state: "open" }, 201);
    }
    if (method === "PATCH" && /\/issues\/\d+$/.test(url)) return json({});
    if (method === "PUT" && /\/issues\/\d+\/labels$/.test(url)) return json([]);
    if (method === "GET" && /\/issues\/\d+\/comments\?/.test(url)) return json([]);
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(url)) return json({ id: 1 }, 201);

    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return {
    requests,
    createdTitles: () =>
      requests
        .filter((r) => r.method === "POST" && r.url === `${DEST_API}/issues`)
        .map((r) => JSON.parse(r.body!).title as string),
    createdBodies: () =>
      requests
        .filter((r) => r.method === "POST" && r.url === `${DEST_API}/issues`)
        .map((r) => JSON.parse(r.body!).body as string),
  };
}

function ghIssue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `body ${number}`,
    state: "open",
    html_url: `https://github.com/acme/demo/issues/${number}`,
    user: { login: "alice", html_url: "https://github.com/alice" },
    labels: [],
    assignees: [],
    created_at: `2026-01-0${number % 9 || 1}T00:00:00Z`,
    updated_at: "2026-09-23T00:00:00Z",
    ...extra,
  };
}

function ghPull(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    body: `pr body ${number}`,
    state: "open",
    html_url: `https://github.com/acme/demo/pull/${number}`,
    user: { login: "bob", html_url: "https://github.com/bob" },
    created_at: "2026-01-01T00:00:00Z",
    merged_at: null,
    base: { ref: "main" },
    head: { ref: `feature-${number}` },
    ...extra,
  };
}

interface GitHubData {
  /** What issues.listForRepo returns (issues and PR entries). */
  issueListing: any[];
  /** What pulls.list returns. */
  pullListing?: any[];
  /** When set, pulls.get throws for these numbers. */
  failDetailFor?: number[];
}

/** Fake Octokit that records every call made through it. */
function fakeOctokit(data: GitHubData) {
  const calls: Array<{ endpoint: string; params: any }> = [];

  const issues = {
    listForRepo: async (params: any) => {
      calls.push({ endpoint: "issues.listForRepo", params });
      return { data: data.issueListing };
    },
    listComments: async (params: any) => {
      calls.push({ endpoint: "issues.listComments", params });
      return { data: [] };
    },
  };
  const pulls = {
    list: async (params: any) => {
      calls.push({ endpoint: "pulls.list", params });
      return { data: data.pullListing ?? [] };
    },
    get: async (params: any) => {
      calls.push({ endpoint: "pulls.get", params });
      if (data.failDetailFor?.includes(params.pull_number)) {
        throw new Error("detail unavailable");
      }
      return {
        data: {
          ...ghPull(params.pull_number),
          additions: 1,
          deletions: 0,
          changed_files: 1,
          merged_by: null,
        },
      };
    },
    listCommits: async (params: any) => {
      calls.push({ endpoint: "pulls.listCommits", params });
      return { data: [] };
    },
    listFiles: async (params: any) => {
      calls.push({ endpoint: "pulls.listFiles", params });
      return { data: [] };
    },
  };

  const octokit = {
    rest: { issues, pulls },
    paginate: async (fn: any, params: any, map?: (res: any) => any) => {
      const res = await fn(params);
      return map ? map(res) : res.data;
    },
  };

  return {
    octokit: octokit as any,
    calls,
    callsTo: (endpoint: string) => calls.filter((c) => c.endpoint === endpoint),
  };
}

function recentCursor(): MetadataSyncCursor {
  return {
    lastPassStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    lastFullPassStartedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function expectedSince(cursor: MetadataSyncCursor) {
  return new Date(
    Date.parse(cursor.lastPassStartedAt) - INCREMENTAL_SYNC_SAFETY_MARGIN_MS
  ).toISOString();
}

describe.skipIf(!isChild)("mirrorGitRepoIssuesToGitea incremental sync", () => {
  it("runs a full pass without a watermark and records one", async () => {
    fakeGitea([]);
    const github = fakeOctokit({
      issueListing: [ghIssue(1), ghIssue(2), ghPull(3, { pull_request: {} })],
    });

    const before = Date.now();
    const cursor = await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
    });
    const after = Date.now();

    const [listing] = github.callsTo("issues.listForRepo");
    expect(listing.params.since).toBeUndefined();
    expect(listing.params.sort).toBe("created");
    expect(listing.params.direction).toBe("asc");
    expect(github.callsTo("issues.listComments").map((c) => c.params.issue_number)).toEqual([1, 2]);

    expect(cursor).toBeDefined();
    const started = Date.parse(cursor!.lastPassStartedAt);
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(after);
    expect(cursor!.lastFullPassStartedAt).toBe(cursor!.lastPassStartedAt);
  });

  it("lists with since and only reconciles the returned issues", async () => {
    fakeGitea([
      { number: 11, title: "[GH-ISSUE #1] Issue 1" },
      { number: 12, title: "[GH-ISSUE #2] Issue 2" },
      { number: 13, title: "[GH-ISSUE #3] Issue 3" },
    ]);
    const github = fakeOctokit({ issueListing: [ghIssue(2)] });
    const previous = recentCursor();

    const cursor = await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: previous,
    });

    const listings = github.callsTo("issues.listForRepo");
    expect(listings).toHaveLength(1);
    expect(listings[0].params.since).toBe(expectedSince(previous));
    expect(listings[0].params.sort).toBe("updated");
    expect(github.callsTo("issues.listComments").map((c) => c.params.issue_number)).toEqual([2]);

    // The watermark moves to this listing; the last full pass is kept.
    expect(cursor).toBeDefined();
    expect(Date.parse(cursor!.lastPassStartedAt)).toBeGreaterThan(
      Date.parse(previous.lastPassStartedAt)
    );
    expect(cursor!.lastFullPassStartedAt).toBe(previous.lastFullPassStartedAt);
  });

  it("creates new issues from an incremental listing in creation order", async () => {
    const gitea = fakeGitea([{ number: 11, title: "[GH-ISSUE #1] Issue 1" }]);
    // GitHub returns them by updated_at: #5 changed before #4.
    const github = fakeOctokit({
      issueListing: [
        ghIssue(5, { created_at: "2026-09-22T10:00:00Z", updated_at: "2026-09-23T01:00:00Z" }),
        ghIssue(4, { created_at: "2026-09-22T09:00:00Z", updated_at: "2026-09-23T02:00:00Z" }),
      ],
    });

    await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: recentCursor(),
    });

    expect(gitea.createdTitles()).toEqual(["[GH-ISSUE #4] Issue 4", "[GH-ISSUE #5] Issue 5"]);
  });

  it("falls back to a full pass when the destination has no mirrored issues", async () => {
    fakeGitea([]);
    const github = fakeOctokit({ issueListing: [ghIssue(1)] });
    const previous = recentCursor();

    const cursor = await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: previous,
    });

    const listings = github.callsTo("issues.listForRepo");
    expect(listings).toHaveLength(2);
    expect(listings[0].params.since).toBe(expectedSince(previous));
    expect(listings[1].params.since).toBeUndefined();
    expect(cursor!.lastFullPassStartedAt).toBe(cursor!.lastPassStartedAt);
  });

  it("runs a full pass when the last full pass is older than 7 days", async () => {
    fakeGitea([{ number: 11, title: "[GH-ISSUE #1] Issue 1" }]);
    const github = fakeOctokit({ issueListing: [ghIssue(1), ghIssue(2)] });

    await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: {
        lastPassStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        lastFullPassStartedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });

    const listings = github.callsTo("issues.listForRepo");
    expect(listings).toHaveLength(1);
    expect(listings[0].params.since).toBeUndefined();
    expect(github.callsTo("issues.listComments")).toHaveLength(2);
  });
});

describe.skipIf(!isChild)("mirrorGitRepoPullRequestsToGitea incremental sync", () => {
  it("runs a full pass with pulls.list without a watermark", async () => {
    fakeGitea([]);
    const github = fakeOctokit({
      issueListing: [],
      pullListing: [ghPull(1), ghPull(2)],
    });

    const cursor = await mirrorGitRepoPullRequestsToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
    });

    expect(github.callsTo("pulls.list")).toHaveLength(1);
    expect(github.callsTo("issues.listForRepo")).toHaveLength(0);
    expect(github.callsTo("pulls.get").map((c) => c.params.pull_number)).toEqual([1, 2]);
    expect(github.callsTo("pulls.listCommits")).toHaveLength(2);
    expect(github.callsTo("pulls.listFiles")).toHaveLength(2);
    expect(cursor).toBeDefined();
    expect(cursor!.lastFullPassStartedAt).toBe(cursor!.lastPassStartedAt);
  });

  it("lists changed pull requests through the issues endpoint with since", async () => {
    const gitea = fakeGitea([
      { number: 21, title: "[PR #1] PR 1" },
      { number: 22, title: "[PR #2] PR 2" },
      { number: 23, title: "[PR #3] PR 3" },
    ]);
    const github = fakeOctokit({
      // Issue #9 changed too; it is not a pull request and is skipped here.
      issueListing: [
        ghIssue(9),
        { ...ghIssue(3), title: "PR 3", pull_request: { merged_at: null } },
        { ...ghIssue(4), title: "PR 4", pull_request: { merged_at: null } },
      ],
    });
    const previous = recentCursor();

    const cursor = await mirrorGitRepoPullRequestsToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: previous,
    });

    expect(github.callsTo("pulls.list")).toHaveLength(0);
    const [listing] = github.callsTo("issues.listForRepo");
    expect(listing.params.since).toBe(expectedSince(previous));
    expect(listing.params.sort).toBe("updated");

    expect(github.callsTo("pulls.get").map((c) => c.params.pull_number).sort()).toEqual([3, 4]);
    expect(github.callsTo("pulls.listCommits")).toHaveLength(2);
    expect(github.callsTo("pulls.listFiles")).toHaveLength(2);

    // The new PR is built from the detail response, which has the refs.
    const [created] = gitea.createdBodies();
    expect(created).toContain("feature-4");
    expect(gitea.createdTitles()).toEqual(["[PR #4] PR 4"]);

    expect(cursor!.lastFullPassStartedAt).toBe(previous.lastFullPassStartedAt);
  });

  it("keeps the previous watermark when a pull request fails", async () => {
    fakeGitea([{ number: 21, title: "[PR #1] PR 1" }]);
    // Detail fails and the basic fallback create also fails.
    globalThis.fetch = ((original) =>
      (async (input: any, init?: any) => {
        const url = typeof input === "string" ? input : String(input);
        if (String(init?.method ?? "GET").toUpperCase() === "POST" && url === `${DEST_API}/issues`) {
          return new Response("boom", { status: 500 });
        }
        return original(input, init);
      }) as unknown as typeof fetch)(globalThis.fetch);
    const github = fakeOctokit({
      issueListing: [{ ...ghIssue(5), pull_request: { merged_at: null } }],
      failDetailFor: [5],
    });

    const cursor = await mirrorGitRepoPullRequestsToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: recentCursor(),
    });

    expect(cursor).toBeUndefined();
    expect(github.callsTo("pulls.get").map((c) => c.params.pull_number)).toEqual([5]);
  });
});
