/**
 * Unit tests for syncRepositoryMetadataToGitea (description + topics).
 *
 * Follow-up to #361: the description was only sent at migration time, from the
 * locally stored value, so mirrors created before it was carried over (#224)
 * or whose upstream description changed since stayed stale for good. The sync
 * path now reconciles it on every run, reading GitHub live when a token is
 * available and skipping writes that would change nothing.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

const okResponse = () => ({
  data: {},
  status: 200,
  statusText: "OK",
  headers: new Headers(),
});

const mockHttpGet = mock(async (_url: string, _headers?: any) => okResponse());
const mockHttpPatch = mock(async (_url: string, _body?: any, _headers?: any) =>
  okResponse()
);
const mockHttpPut = mock(async (_url: string, _body?: any, _headers?: any) =>
  okResponse()
);
const mockHttpPost = mock(async () => okResponse());
const mockHttpDelete = mock(async () => okResponse());

class MockHttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public response?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

mock.module("@/lib/http-client", () => ({
  httpGet: mockHttpGet,
  httpPatch: mockHttpPatch,
  httpPut: mockHttpPut,
  httpPost: mockHttpPost,
  httpDelete: mockHttpDelete,
  HttpError: MockHttpError,
}));

// Capture what gets written back to the repositories row.
const dbUpdateSetCalls: any[] = [];
mock.module("@/lib/db", () => ({
  db: {
    update: () => ({
      set: (data: any) => {
        dbUpdateSetCalls.push(data);
        return { where: async () => {} };
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    insert: () => ({ values: async () => ({}) }),
  },
  users: {},
  configs: {},
  repositories: {},
  organizations: {},
  mirrorJobs: {},
  events: {},
  accounts: {},
  sessions: {},
}));

mock.module("@/lib/helpers", () => ({
  createMirrorJob: mock(async () => "job-id"),
}));

import { syncRepositoryMetadataToGitea } from "./gitea";
import type { Config, Repository } from "./db/schema";

const GITEA_URL = "https://gitea.example.com";
const REPO_API = `${GITEA_URL}/api/v1/repos/mirror/browser-use`;
const UPSTREAM_DESCRIPTION = "Make websites accessible for AI agents";

function makeConfig(gitea: Record<string, unknown> = {}): Partial<Config> {
  return {
    userId: "user-1",
    giteaConfig: {
      url: GITEA_URL,
      token: "gitea-token",
      defaultOwner: "mirror",
      ...gitea,
    } as any,
  };
}

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-1",
    userId: "user-1",
    name: "browser-use",
    fullName: "browser-use/browser-use",
    owner: "browser-use",
    cloneUrl: "https://github.com/browser-use/browser-use.git",
    isPrivate: false,
    isStarred: false,
    status: "mirrored",
    visibility: "public",
    description: "stored description",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Repository;
}

/** Octokit stand-in: a single `request` that resolves to `data` or throws. */
function makeOctokit(result: Record<string, unknown> | Error) {
  const request = mock(async () => {
    if (result instanceof Error) throw result;
    return { data: result, status: 200, headers: {} };
  });
  return { request } as any;
}

async function run(opts: {
  octokit: any;
  repository?: Repository;
  config?: Partial<Config>;
  current?: { description?: string | null; topics?: string[] | null } | null;
}) {
  await syncRepositoryMetadataToGitea({
    config: opts.config ?? makeConfig(),
    octokit: opts.octokit,
    repository: opts.repository ?? makeRepo(),
    giteaOwner: "mirror",
    giteaRepoName: "browser-use",
    giteaToken: "gitea-token",
    current: opts.current,
  });
}

beforeEach(() => {
  mockHttpPatch.mockClear();
  mockHttpPut.mockClear();
  dbUpdateSetCalls.length = 0;
});

describe("syncRepositoryMetadataToGitea", () => {
  test("reads description and topics from GitHub in one call and writes both to Gitea", async () => {
    const octokit = makeOctokit({
      description: UPSTREAM_DESCRIPTION,
      topics: ["ai", "browser"],
    });

    await run({ octokit });

    expect(octokit.request).toHaveBeenCalledTimes(1);
    expect(octokit.request.mock.calls[0][0]).toBe("GET /repos/{owner}/{repo}");
    expect(octokit.request.mock.calls[0][1]).toMatchObject({
      owner: "browser-use",
      repo: "browser-use",
    });

    expect(mockHttpPatch).toHaveBeenCalledTimes(1);
    expect(mockHttpPatch.mock.calls[0][0]).toBe(REPO_API);
    expect(mockHttpPatch.mock.calls[0][1]).toEqual({
      description: UPSTREAM_DESCRIPTION,
    });

    expect(mockHttpPut).toHaveBeenCalledTimes(1);
    expect(mockHttpPut.mock.calls[0][0]).toBe(`${REPO_API}/topics`);
    expect(mockHttpPut.mock.calls[0][1]).toEqual({ topics: ["ai", "browser"] });
  });

  test("GitHub wins over the stored description and the row is refreshed", async () => {
    await run({
      octokit: makeOctokit({ description: UPSTREAM_DESCRIPTION, topics: [] }),
    });

    expect(mockHttpPatch.mock.calls[0][1]).toEqual({
      description: UPSTREAM_DESCRIPTION,
    });
    expect(dbUpdateSetCalls).toHaveLength(1);
    expect(dbUpdateSetCalls[0].description).toBe(UPSTREAM_DESCRIPTION);
  });

  test("leaves the row alone when the stored description already matches", async () => {
    await run({
      octokit: makeOctokit({ description: "stored description", topics: [] }),
    });

    expect(dbUpdateSetCalls).toHaveLength(0);
  });

  test("skips both writes when Gitea already holds the upstream values", async () => {
    await run({
      octokit: makeOctokit({
        description: UPSTREAM_DESCRIPTION,
        topics: ["ai", "browser"],
      }),
      // Topic order from Gitea is not guaranteed; the comparison is a set.
      current: { description: UPSTREAM_DESCRIPTION, topics: ["browser", "ai"] },
    });

    expect(mockHttpPatch).not.toHaveBeenCalled();
    expect(mockHttpPut).not.toHaveBeenCalled();
  });

  test("writes only what changed", async () => {
    await run({
      octokit: makeOctokit({
        description: UPSTREAM_DESCRIPTION,
        topics: ["ai", "browser", "llm"],
      }),
      current: { description: UPSTREAM_DESCRIPTION, topics: ["ai", "browser"] },
    });

    expect(mockHttpPatch).not.toHaveBeenCalled();
    expect(mockHttpPut).toHaveBeenCalledTimes(1);
    expect(mockHttpPut.mock.calls[0][1]).toEqual({
      topics: ["ai", "browser", "llm"],
    });
  });

  test("a Gitea repo that never had a description still gets one", async () => {
    // Gitea reports an empty description for such repos. That must read as
    // "differs from upstream", not "unknown, skip".
    await run({
      octokit: makeOctokit({ description: UPSTREAM_DESCRIPTION, topics: [] }),
      current: { description: "", topics: [] },
    });

    expect(mockHttpPatch).toHaveBeenCalledTimes(1);
    expect(mockHttpPatch.mock.calls[0][1]).toEqual({
      description: UPSTREAM_DESCRIPTION,
    });
  });

  test("without `current` the description is written unconditionally (migration path)", async () => {
    await run({
      octokit: makeOctokit({ description: UPSTREAM_DESCRIPTION, topics: [] }),
    });

    expect(mockHttpPatch).toHaveBeenCalledTimes(1);
  });

  test("an empty upstream description clears the Gitea one and the stored one", async () => {
    await run({
      octokit: makeOctokit({ description: null, topics: [] }),
      current: { description: "old text", topics: [] },
    });

    expect(mockHttpPatch.mock.calls[0][1]).toEqual({ description: "" });
    expect(dbUpdateSetCalls).toHaveLength(1);
    expect(dbUpdateSetCalls[0].description).toBeNull();
  });

  test("falls back to the stored description when GitHub is unreachable", async () => {
    await run({ octokit: makeOctokit(new Error("GitHub down")) });

    expect(mockHttpPatch).toHaveBeenCalledTimes(1);
    expect(mockHttpPatch.mock.calls[0][1]).toEqual({
      description: "stored description",
    });
    // Nothing fresh to store, and no topic list to push.
    expect(dbUpdateSetCalls).toHaveLength(0);
    expect(mockHttpPut).not.toHaveBeenCalled();
  });

  test("a GitHub outage never wipes a description Gitea already has", async () => {
    // With no stored value and no upstream answer there is nothing
    // authoritative to write, so the transient-failure path must not PATCH
    // an empty string over a real description.
    await run({
      octokit: makeOctokit(new Error("GitHub down")),
      repository: makeRepo({ description: null }),
      current: { description: UPSTREAM_DESCRIPTION, topics: [] },
    });

    expect(mockHttpPatch).not.toHaveBeenCalled();
  });

  test("without a GitHub token uses the stored description and skips topics", async () => {
    await run({ octokit: null });

    expect(mockHttpPatch).toHaveBeenCalledTimes(1);
    expect(mockHttpPatch.mock.calls[0][1]).toEqual({
      description: "stored description",
    });
    expect(mockHttpPut).not.toHaveBeenCalled();
    expect(dbUpdateSetCalls).toHaveLength(0);
  });

  test("honors addTopics=false but still syncs the description", async () => {
    await run({
      octokit: makeOctokit({ description: UPSTREAM_DESCRIPTION, topics: ["ai"] }),
      config: makeConfig({ addTopics: false }),
    });

    expect(mockHttpPatch).toHaveBeenCalledTimes(1);
    expect(mockHttpPut).not.toHaveBeenCalled();
  });

  test("applies the configured topic prefix before comparing and writing", async () => {
    await run({
      octokit: makeOctokit({
        description: UPSTREAM_DESCRIPTION,
        topics: ["AI", "Browser Use"],
      }),
      config: makeConfig({ topicPrefix: "gh" }),
      current: { description: UPSTREAM_DESCRIPTION, topics: ["gh-ai"] },
    });

    expect(mockHttpPut).toHaveBeenCalledTimes(1);
    expect(mockHttpPut.mock.calls[0][1]).toEqual({
      topics: ["gh-ai", "gh-browser-use"],
    });
  });

  test("a failed Gitea write is logged, not thrown, and topics still get their turn", async () => {
    mockHttpPatch.mockImplementationOnce(async () => {
      throw new MockHttpError("nope", 500, "Server Error");
    });

    await expect(
      run({
        octokit: makeOctokit({ description: UPSTREAM_DESCRIPTION, topics: ["ai"] }),
      })
    ).resolves.toBeUndefined();

    expect(mockHttpPut).toHaveBeenCalledTimes(1);
  });
});
