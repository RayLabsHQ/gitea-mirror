/**
 * Regression test for issue #268.
 *
 * When the Gitea migrate call (or anything before it inside the try block)
 * threw, the catch block referenced `migrateSucceeded` which had been
 * declared with `let` *inside* the same try block. Block-scoping made the
 * variable invisible to the catch, so the catch crashed with
 * `ReferenceError: migrateSucceeded is not defined` before reaching the
 * DB update that marks the repo "failed". Result: repos stuck in
 * "mirroring" forever with no failure entry in the activity log.
 *
 * These tests force a failure inside the try block and assert the catch
 * runs all the way through.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Octokit } from "@octokit/rest";

// Track DB update payloads so we can assert on the catch-block side effects.
const dbUpdateCalls: any[] = [];
const createMirrorJobCalls: any[] = [];

mock.module("@/lib/db", () => {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
      update: () => ({
        set: (payload: any) => {
          dbUpdateCalls.push(payload);
          return {
            where: () => Promise.resolve(),
          };
        },
      }),
    },
    users: {},
    events: {},
    configs: {},
    repositories: {},
    mirrorJobs: {},
    organizations: {},
    sessions: {},
    accounts: {},
    verificationTokens: {},
    oauthApplications: {},
    oauthAccessTokens: {},
    oauthConsent: {},
    ssoProviders: {},
  };
});

mock.module("@/lib/helpers", () => {
  return {
    createMirrorJob: mock((args: any) => {
      createMirrorJobCalls.push(args);
      return Promise.resolve("mock-job-id");
    }),
    createEvent: mock(() => Promise.resolve()),
  };
});

// httpPost throws to simulate the migrate (or any earlier POST) timing out.
const NETWORK_ERROR = "Network error: The operation timed out.";
mock.module("@/lib/http-client", () => {
  return {
    httpRequest: mock(() => Promise.reject(new Error(NETWORK_ERROR))),
    httpPost: mock(() => Promise.reject(new Error(NETWORK_ERROR))),
    httpGet: mock(() =>
      Promise.resolve({
        data: null,
        status: 404,
        statusText: "Not Found",
        headers: new Headers(),
      })
    ),
    httpPut: mock(() =>
      Promise.resolve({
        data: {},
        status: 200,
        statusText: "OK",
        headers: new Headers(),
      })
    ),
    httpPatch: mock(() =>
      Promise.resolve({
        data: {},
        status: 200,
        statusText: "OK",
        headers: new Headers(),
      })
    ),
    httpDelete: mock(() =>
      Promise.resolve({
        data: {},
        status: 204,
        statusText: "No Content",
        headers: new Headers(),
      })
    ),
    HttpError: class MockHttpError extends Error {
      constructor(
        message: string,
        public status: number,
        public statusText: string,
        public response?: string
      ) {
        super(message);
        this.name = "HttpError";
      }
    },
  };
});

// gitea-enhanced is dynamically imported by gitea.ts — mock so its
// helpers don't try to hit a real Gitea or call into uninitialised state.
mock.module("@/lib/gitea-enhanced", () => {
  return {
    getOrCreateGiteaOrgEnhanced: mock(() => Promise.resolve(123)),
    getGiteaRepoInfo: mock(() => Promise.resolve(null)),
    handleExistingNonMirrorRepo: mock(() => Promise.resolve()),
    syncGiteaRepoEnhanced: mock(() => Promise.resolve({})),
  };
});

const { mirrorGithubRepoToGitea, mirrorGitHubRepoToGiteaOrg } = await import("./gitea");

const baseConfig: any = {
  id: "config-id",
  userId: "user-id",
  githubConfig: {
    owner: "alice",
    username: "alice",
    token: "github-token",
    type: "personal",
    starredReposMode: "dedicated-org",
    mirrorStrategy: "flat-user",
  },
  giteaConfig: {
    url: "https://gitea.example.com",
    token: "gitea-token",
    defaultOwner: "alice",
    mirrorInterval: "8h",
  },
};

const baseRepo: any = {
  id: "repo-id",
  userId: "user-id",
  configId: "config-id",
  name: "test-repo",
  fullName: "alice/test-repo",
  url: "https://github.com/alice/test-repo",
  cloneUrl: "https://github.com/alice/test-repo.git",
  owner: "alice",
  isPrivate: false,
  isStarred: false,
  status: "imported",
  mirroredLocation: "",
};

describe("issue #268 — repos stuck in 'mirroring' when migrate throws", () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    createMirrorJobCalls.length = 0;
  });

  test("mirrorGithubRepoToGitea catch updates DB to 'failed' when httpPost throws", async () => {
    let thrown: Error | null = null;
    try {
      await mirrorGithubRepoToGitea({
        octokit: {} as Octokit,
        repository: baseRepo,
        config: baseConfig,
      });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Original cause must be preserved, not swallowed by a ReferenceError.
    expect(thrown!.message).toContain(NETWORK_ERROR);
    expect(thrown!.message).not.toContain("migrateSucceeded is not defined");

    // The catch must have updated the repo to "failed" — this is what was
    // missing before the fix and caused repos to stay in "mirroring".
    const failedUpdate = dbUpdateCalls.find((p) => p?.status === "failed");
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate.errorMessage).toContain(NETWORK_ERROR);
    // mirroredLocation should be cleared when migrate never succeeded.
    expect(failedUpdate.mirroredLocation).toBe("");

    // And the activity log must record the failure.
    const failedJob = createMirrorJobCalls.find((c) => c.status === "failed");
    expect(failedJob).toBeDefined();
  });

  test("mirrorGitHubRepoToGiteaOrg catch updates DB to 'failed' when httpPost throws", async () => {
    let thrown: Error | null = null;
    try {
      await mirrorGitHubRepoToGiteaOrg({
        octokit: {} as Octokit,
        config: baseConfig,
        repository: baseRepo,
        giteaOrgId: 123,
        orgName: "alice",
      });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toContain(NETWORK_ERROR);
    expect(thrown!.message).not.toContain("migrateSucceeded is not defined");

    const failedUpdate = dbUpdateCalls.find((p) => p?.status === "failed");
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate.errorMessage).toContain(NETWORK_ERROR);
    expect(failedUpdate.mirroredLocation).toBe("");

    const failedJob = createMirrorJobCalls.find((c) => c.status === "failed");
    expect(failedJob).toBeDefined();
  });
});
