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
import type { MetadataPassProgress, MetadataSyncCursor } from "@/lib/metadata-state";

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
  /** GitHub refuses the comment listing of these issues with a rate limit. */
  rateLimitCommentsFor?: number[];
  /** GitHub refuses pulls.get for these numbers with a rate limit. */
  rateLimitDetailFor?: number[];
}

function rateLimitRefusal() {
  return Object.assign(new Error("API rate limit exceeded for user ID 1."), { status: 403 });
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
      if (data.rateLimitCommentsFor?.includes(params.issue_number)) throw rateLimitRefusal();
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
      if (data.rateLimitDetailFor?.includes(params.pull_number)) throw rateLimitRefusal();
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
    // #1 is in Gitea and has not changed since the last pass, so the full
    // pass does not list its comments again; #2 is new.
    expect(github.callsTo("issues.listComments").map((c) => c.params.issue_number)).toEqual([2]);
  });
});

describe.skipIf(!isChild)("full passes that revisit unchanged items (#449 follow-up)", () => {
  const weekOldFullPass = (): MetadataSyncCursor => ({
    lastPassStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    lastFullPassStartedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const recently = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();

  it("only lists comments for issues that changed or are missing", async () => {
    const gitea = fakeGitea([
      { number: 11, title: "[GH-ISSUE #1] Issue 1" },
      { number: 12, title: "[GH-ISSUE #2] Issue 2" },
    ]);
    const github = fakeOctokit({
      issueListing: [ghIssue(1), ghIssue(2, { updated_at: recently() }), ghIssue(3)],
    });

    const cursor = await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: weekOldFullPass(),
    });

    expect(github.callsTo("issues.listComments").map((c) => c.params.issue_number)).toEqual([2, 3]);
    // The unchanged issue is still brought in line from the listing.
    expect(
      gitea.requests.some((r) => r.method === "PATCH" && r.url === `${DEST_API}/issues/11`)
    ).toBe(true);
    expect(gitea.createdTitles()).toEqual(["[GH-ISSUE #3] Issue 3"]);
    expect(cursor!.lastFullPassStartedAt).toBe(cursor!.lastPassStartedAt);
  });

  it("leaves an unchanged issue alone when the Gitea copy already matches", async () => {
    const gitea = fakeGitea([]);
    const issue = ghIssue(1);
    const matching = {
      number: 11,
      title: "[GH-ISSUE #1] Issue 1",
      body:
        `Originally created by @alice on GitHub (${new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }).format(new Date(issue.created_at))}).\n` +
        `Original GitHub issue: ${issue.html_url}\n\n${issue.body}`,
      state: "open",
      labels: [],
    };
    // Serve an exact copy by overriding the listing response.
    globalThis.fetch = ((original) =>
      (async (input: any, init?: any) => {
        const url = typeof input === "string" ? input : String(input);
        const method = String(init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.startsWith(`${DEST_API}/issues?`) && !url.includes("&q=")) {
          const page = Number(new URL(url).searchParams.get("page") ?? "1");
          return new Response(JSON.stringify(page === 1 ? [matching] : []), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return original(input, init);
      }) as unknown as typeof fetch)(globalThis.fetch);
    const github = fakeOctokit({ issueListing: [issue] });

    await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: weekOldFullPass(),
    });

    expect(github.callsTo("issues.listComments")).toHaveLength(0);
    // Nothing to write either: no edit, no label reset, no create.
    expect(gitea.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("skips the detail, commits and files calls for unchanged pull requests", async () => {
    fakeGitea([
      { number: 21, title: "[PR #1] PR 1" },
      { number: 22, title: "[PR #2] PR 2" },
    ]);
    const github = fakeOctokit({
      issueListing: [],
      pullListing: [
        ghPull(1, { updated_at: "2026-09-01T00:00:00Z" }),
        ghPull(2, { updated_at: recently() }),
        ghPull(3, { updated_at: "2026-09-01T00:00:00Z" }),
      ],
    });

    const cursor = await mirrorGitRepoPullRequestsToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: weekOldFullPass(),
    });

    // #1 is unchanged and mirrored; #2 changed; #3 is missing in Gitea.
    expect(github.callsTo("pulls.get").map((c) => c.params.pull_number)).toEqual([2, 3]);
    expect(github.callsTo("pulls.listCommits")).toHaveLength(2);
    expect(github.callsTo("pulls.listFiles")).toHaveLength(2);
    expect(cursor!.lastFullPassStartedAt).toBe(cursor!.lastPassStartedAt);
  });

  it("does not treat anything as unchanged on the first pass, when there is no watermark", async () => {
    fakeGitea([{ number: 21, title: "[PR #1] PR 1" }]);
    const github = fakeOctokit({
      issueListing: [],
      pullListing: [ghPull(1, { updated_at: "2026-09-01T00:00:00Z" })],
    });

    await mirrorGitRepoPullRequestsToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
    });

    expect(github.callsTo("pulls.get").map((c) => c.params.pull_number)).toEqual([1]);
  });
});

describe.skipIf(!isChild)("passes stopped by the rate limit resume (#449 follow-up)", () => {
  it("keeps the finished issues and continues from there on the next run", async () => {
    fakeGitea([]);
    const listing = [ghIssue(1), ghIssue(2), ghIssue(3), ghIssue(4)];
    const saved: Array<MetadataPassProgress | undefined> = [];

    const first = fakeOctokit({ issueListing: listing, rateLimitCommentsFor: [3] });
    let caught: unknown;
    try {
      await mirrorGitRepoIssuesToGitea({
        config,
        octokit: first.octokit,
        repository,
        giteaOwner: DEST_OWNER,
        giteaRepoName: DEST_REPO,
        onPassProgress: (progress) => void saved.push(progress),
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("rate limit");
    // #3 was refused and #4 never started.
    expect(first.callsTo("issues.listComments").map((c) => c.params.issue_number)).toEqual([1, 2, 3]);
    expect(saved).toHaveLength(1);
    const progress = saved[0]!;
    expect(progress.mode).toBe("full");
    expect(progress.done).toEqual([[1, 2]]);

    // Next run, budget back: #1 and #2 are not fetched again.
    fakeGitea([
      { number: 11, title: "[GH-ISSUE #1] Issue 1" },
      { number: 12, title: "[GH-ISSUE #2] Issue 2" },
      { number: 13, title: "[GH-ISSUE #3] Issue 3" },
    ]);
    const second = fakeOctokit({ issueListing: listing });
    const cursor = await mirrorGitRepoIssuesToGitea({
      config,
      octokit: second.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      passProgress: progress,
      onPassProgress: (next) => void saved.push(next),
    });

    const [relisting] = second.callsTo("issues.listForRepo");
    expect(relisting.params.since).toBeUndefined();
    expect(second.callsTo("issues.listComments").map((c) => c.params.issue_number)).toEqual([3, 4]);
    // Completed: the progress is cleared and the watermark is the start of
    // the first attempt, so nothing changed in between is missed.
    expect(saved[saved.length - 1]).toBeUndefined();
    expect(cursor!.lastPassStartedAt).toBe(progress.startedAt);
    expect(cursor!.lastFullPassStartedAt).toBe(progress.startedAt);
  });

  it("redoes a finished issue that changed after the interrupted pass started", async () => {
    fakeGitea([
      { number: 11, title: "[GH-ISSUE #1] Issue 1" },
      { number: 12, title: "[GH-ISSUE #2] Issue 2" },
    ]);
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const github = fakeOctokit({
      issueListing: [ghIssue(1), ghIssue(2, { updated_at: new Date().toISOString() })],
    });

    await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      passProgress: { mode: "full", startedAt, done: [[1, 2]] },
    });

    expect(github.callsTo("issues.listComments").map((c) => c.params.issue_number)).toEqual([2]);
  });

  it("resumes an incremental pass with the same since", async () => {
    fakeGitea([{ number: 11, title: "[GH-ISSUE #1] Issue 1" }]);
    const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const github = fakeOctokit({ issueListing: [ghIssue(1), ghIssue(2)] });

    const cursor = await mirrorGitRepoIssuesToGitea({
      config,
      octokit: github.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      syncCursor: recentCursor(),
      passProgress: { mode: "incremental", since, startedAt, done: [[1, 1]] },
    });

    const [listing] = github.callsTo("issues.listForRepo");
    expect(listing.params.since).toBe(since);
    expect(github.callsTo("issues.listComments").map((c) => c.params.issue_number)).toEqual([2]);
    expect(cursor!.lastPassStartedAt).toBe(startedAt);
  });

  it("keeps the finished pull requests when the detail call is refused", async () => {
    fakeGitea([]);
    const pullListing = [ghPull(1), ghPull(2), ghPull(3)].map((pr) => ({
      ...pr,
      updated_at: "2026-09-01T00:00:00Z",
    }));
    const saved: Array<MetadataPassProgress | undefined> = [];
    const first = fakeOctokit({ issueListing: [], pullListing, rateLimitDetailFor: [2] });

    await expect(
      mirrorGitRepoPullRequestsToGitea({
        config,
        octokit: first.octokit,
        repository,
        giteaOwner: DEST_OWNER,
        giteaRepoName: DEST_REPO,
        onPassProgress: (progress) => void saved.push(progress),
      })
    ).rejects.toThrow(/rate limit/i);
    expect(saved[0]!.done).toEqual([[1, 1]]);

    fakeGitea([{ number: 21, title: "[PR #1] PR 1" }]);
    const second = fakeOctokit({ issueListing: [], pullListing });
    await mirrorGitRepoPullRequestsToGitea({
      config,
      octokit: second.octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      passProgress: saved[0],
    });
    expect(second.callsTo("pulls.get").map((c) => c.params.pull_number)).toEqual([2, 3]);
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
