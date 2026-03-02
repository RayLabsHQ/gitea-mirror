import { describe, expect, it, mock } from "bun:test";
import {
  detectForcePush,
  fetchGitHubBranches,
  checkAncestry,
  type BranchInfo,
} from "./force-push-detection";

// ---- Helpers ----

function makeOctokit(overrides: Record<string, any> = {}) {
  return {
    repos: {
      listBranches: mock(() => Promise.resolve({ data: [] })),
      compareCommits: mock(() =>
        Promise.resolve({ data: { status: "ahead" } }),
      ),
      ...overrides.repos,
    },
    paginate: mock(async (_method: any, params: any) => {
      // Default: return whatever the test wired into _githubBranches
      return overrides._githubBranches ?? [];
    }),
    ...overrides,
  } as any;
}

// ---- fetchGitHubBranches ----

describe("fetchGitHubBranches", () => {
  it("maps Octokit paginated response to BranchInfo[]", async () => {
    const octokit = makeOctokit({
      _githubBranches: [
        { name: "main", commit: { sha: "aaa" } },
        { name: "dev", commit: { sha: "bbb" } },
      ],
    });

    const result = await fetchGitHubBranches({
      octokit,
      owner: "user",
      repo: "repo",
    });

    expect(result).toEqual([
      { name: "main", sha: "aaa" },
      { name: "dev", sha: "bbb" },
    ]);
  });
});

// ---- checkAncestry ----

describe("checkAncestry", () => {
  it("returns true for fast-forward (ahead)", async () => {
    const octokit = makeOctokit({
      repos: {
        compareCommits: mock(() =>
          Promise.resolve({ data: { status: "ahead" } }),
        ),
      },
    });

    const result = await checkAncestry({
      octokit,
      owner: "user",
      repo: "repo",
      baseSha: "old",
      headSha: "new",
    });

    expect(result).toBe(true);
  });

  it("returns true for identical", async () => {
    const octokit = makeOctokit({
      repos: {
        compareCommits: mock(() =>
          Promise.resolve({ data: { status: "identical" } }),
        ),
      },
    });

    const result = await checkAncestry({
      octokit,
      owner: "user",
      repo: "repo",
      baseSha: "same",
      headSha: "same",
    });

    expect(result).toBe(true);
  });

  it("returns false for diverged", async () => {
    const octokit = makeOctokit({
      repos: {
        compareCommits: mock(() =>
          Promise.resolve({ data: { status: "diverged" } }),
        ),
      },
    });

    const result = await checkAncestry({
      octokit,
      owner: "user",
      repo: "repo",
      baseSha: "old",
      headSha: "new",
    });

    expect(result).toBe(false);
  });

  it("returns false when API returns 404 (old SHA gone)", async () => {
    const error404 = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = makeOctokit({
      repos: {
        compareCommits: mock(() => Promise.reject(error404)),
      },
    });

    const result = await checkAncestry({
      octokit,
      owner: "user",
      repo: "repo",
      baseSha: "gone",
      headSha: "new",
    });

    expect(result).toBe(false);
  });

  it("throws on transient errors (fail-open for caller)", async () => {
    const error500 = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const octokit = makeOctokit({
      repos: {
        compareCommits: mock(() => Promise.reject(error500)),
      },
    });

    expect(
      checkAncestry({
        octokit,
        owner: "user",
        repo: "repo",
        baseSha: "old",
        headSha: "new",
      }),
    ).rejects.toThrow("Internal Server Error");
  });
});

// ---- detectForcePush ----
// Uses _deps injection to avoid fragile global fetch mocking.

describe("detectForcePush", () => {
  const baseArgs = {
    giteaUrl: "https://gitea.example.com",
    giteaToken: "tok",
    giteaOwner: "org",
    giteaRepo: "repo",
    githubOwner: "user",
    githubRepo: "repo",
  };

  function makeDeps(overrides: {
    giteaBranches?: BranchInfo[] | Error;
    githubBranches?: BranchInfo[] | Error;
    ancestryResult?: boolean;
  } = {}) {
    return {
      fetchGiteaBranches: mock(async () => {
        if (overrides.giteaBranches instanceof Error) throw overrides.giteaBranches;
        return overrides.giteaBranches ?? [];
      }) as any,
      fetchGitHubBranches: mock(async () => {
        if (overrides.githubBranches instanceof Error) throw overrides.githubBranches;
        return overrides.githubBranches ?? [];
      }) as any,
      checkAncestry: mock(async () => overrides.ancestryResult ?? true) as any,
    };
  }

  const dummyOctokit = {} as any;

  it("skips when Gitea has no branches (first mirror)", async () => {
    const deps = makeDeps({ giteaBranches: [] });
    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("No Gitea branches");
  });

  it("returns no detection when all SHAs match", async () => {
    const deps = makeDeps({
      giteaBranches: [
        { name: "main", sha: "aaa" },
        { name: "dev", sha: "bbb" },
      ],
      githubBranches: [
        { name: "main", sha: "aaa" },
        { name: "dev", sha: "bbb" },
      ],
    });

    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.affectedBranches).toHaveLength(0);
  });

  it("detects deleted branch", async () => {
    const deps = makeDeps({
      giteaBranches: [
        { name: "main", sha: "aaa" },
        { name: "old-branch", sha: "ccc" },
      ],
      githubBranches: [{ name: "main", sha: "aaa" }],
    });

    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(true);
    expect(result.affectedBranches).toHaveLength(1);
    expect(result.affectedBranches[0]).toEqual({
      name: "old-branch",
      reason: "deleted",
      giteaSha: "ccc",
      githubSha: null,
    });
  });

  it("returns no detection for fast-forward", async () => {
    const deps = makeDeps({
      giteaBranches: [{ name: "main", sha: "old-sha" }],
      githubBranches: [{ name: "main", sha: "new-sha" }],
      ancestryResult: true, // fast-forward
    });

    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(false);
    expect(result.affectedBranches).toHaveLength(0);
  });

  it("detects diverged branch", async () => {
    const deps = makeDeps({
      giteaBranches: [{ name: "main", sha: "old-sha" }],
      githubBranches: [{ name: "main", sha: "rewritten-sha" }],
      ancestryResult: false, // diverged
    });

    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(true);
    expect(result.affectedBranches).toHaveLength(1);
    expect(result.affectedBranches[0]).toEqual({
      name: "main",
      reason: "diverged",
      giteaSha: "old-sha",
      githubSha: "rewritten-sha",
    });
  });

  it("detects force-push when ancestry check fails (old SHA gone)", async () => {
    const deps = makeDeps({
      giteaBranches: [{ name: "main", sha: "old-sha" }],
      githubBranches: [{ name: "main", sha: "new-sha" }],
      ancestryResult: false, // checkAncestry returns false on error
    });

    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(true);
    expect(result.affectedBranches).toHaveLength(1);
    expect(result.affectedBranches[0].reason).toBe("diverged");
  });

  it("skips when Gitea API returns 404", async () => {
    const { HttpError } = await import("@/lib/http-client");
    const deps = makeDeps({
      giteaBranches: new HttpError("not found", 404, "Not Found"),
    });

    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("not found");
  });

  it("skips when Gitea API returns server error", async () => {
    const deps = makeDeps({
      giteaBranches: new Error("HTTP 500: internal error"),
    });

    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("Failed to fetch Gitea branches");
  });

  it("skips when GitHub API fails", async () => {
    const deps = makeDeps({
      giteaBranches: [{ name: "main", sha: "aaa" }],
      githubBranches: new Error("rate limited"),
    });

    const result = await detectForcePush({ ...baseArgs, octokit: dummyOctokit, _deps: deps });

    expect(result.detected).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("Failed to fetch GitHub branches");
  });
});
