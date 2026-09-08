import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Create a mock POST function
const mockPOST = mock(async ({ request }) => {
  const body = await request.json();

  // Check for missing userId or organizationIds
  if (!body.userId || !body.organizationIds) {
    return new Response(
      JSON.stringify({
        error: "Missing userId or organizationIds."
      }),
      { status: 400 }
    );
  }

  // Success case
  return new Response(
    JSON.stringify({
      success: true,
      message: "Organization mirroring started",
      batchId: "test-batch-id"
    }),
    { status: 200 }
  );
});

// Create a mock module
const mockModule = {
  POST: mockPOST
};

describe("Organization Mirroring API", () => {
  // Mock console.log and console.error to prevent test output noise
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  test("returns 400 if userId is missing", async () => {
    const request = new Request("http://localhost/api/job/mirror-org", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        organizationIds: ["org-id-1", "org-id-2"]
      })
    });

    const response = await mockModule.POST({ request } as any);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toBe("Missing userId or organizationIds.");
  });

  test("returns 400 if organizationIds is missing", async () => {
    const request = new Request("http://localhost/api/job/mirror-org", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "user-id"
      })
    });

    const response = await mockModule.POST({ request } as any);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toBe("Missing userId or organizationIds.");
  });

  test("returns 200 and starts mirroring organizations", async () => {
    const request = new Request("http://localhost/api/job/mirror-org", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "user-id",
        organizationIds: ["org-id-1", "org-id-2"]
      })
    });

    const response = await mockModule.POST({ request } as any);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe("Organization mirroring started");
    expect(data.batchId).toBe("test-batch-id");
  });
});

// ---------------------------------------------------------------------------
// Real-module tests for the route's per-repository GitHub client resolver.
//
// Same convention as mirror-repo.test.ts: mock.module covers the db, the
// source rows, the GitHub client factories, the Gitea mirroring entry point
// and the concurrency helper, so the real POST handler runs and hands its
// resolveRepositoryOctokit to the (mocked) mirror function, which these
// tests then invoke directly with controlled repository rows.
const authenticatedClient = { authenticated: true };
const anonymousClient = { anonymous: true };
const mockCreateGitHubClient = mock(() => authenticatedClient);
const mockCreatePublicGitHubClient = mock(() => anonymousClient);

mock.module("@/lib/github", () => ({
  createGitHubClient: mockCreateGitHubClient,
  createPublicGitHubClient: mockCreatePublicGitHubClient,
}));

const mockConfigRow = [
  {
    id: "config-id",
    userId: "user-id",
    githubConfig: { token: "github-token" },
    giteaConfig: { url: "https://gitea.example.com", token: "gitea-token" },
  },
];

const mockOrgRows = [
  {
    id: "org-id-1",
    userId: "user-id",
    name: "org-one",
    status: "imported",
    membershipRole: "admin",
    lastMirrored: null,
    errorMessage: null,
  },
];

const mockConfigs = {};
const mockOrganizations = {};

const mockDb = {
  select: mock(() => ({
    from: mock((table: any) => ({
      where: mock(() => {
        // The organizations query is awaited right after where(); the
        // configs query chains orderBy().limit() first.
        if (table === mockOrganizations) {
          return Promise.resolve(mockOrgRows);
        }
        return {
          orderBy: mock(() => ({
            limit: mock(() => Promise.resolve(mockConfigRow)),
          })),
        };
      }),
    })),
  })),
};

mock.module("@/lib/db", () => ({
  db: mockDb,
  configs: mockConfigs,
  organizations: mockOrganizations,
  users: {},
  ssoProviders: {},
  mirrorJobs: {},
  repositories: {},
  events: {},
  accounts: {},
  sessions: {},
}));

const mockMirrorGitHubOrgToGitea = mock(() => Promise.resolve());

mock.module("@/lib/gitea", () => ({
  mirrorGitHubOrgToGitea: mockMirrorGitHubOrgToGitea,
}));

// One tokenless GitHub source, one token-bearing GitHub Enterprise source and
// one GitLab source, so each resolver case can pin its repository by sourceId.
const resolverSourceRows = [
  {
    id: "source-github-public",
    userId: "user-id",
    name: "GitHub (public orgs)",
    provider: "github",
    url: "https://github.com",
    username: "",
    token: null,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  {
    id: "source-github-token",
    userId: "user-id",
    name: "GitHub Enterprise (token)",
    provider: "github",
    url: "https://github.example.com",
    username: "tokenuser",
    token: "source-token",
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  {
    id: "source-gitlab",
    userId: "user-id",
    name: "GitLab",
    provider: "gitlab",
    url: "https://gitlab.com",
    username: "",
    token: "gitlab-token",
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
];

mock.module("@/lib/sources", () => ({
  listSources: mock(async (userId: string) =>
    resolverSourceRows.filter((source) => source.userId === userId)
  ),
  findSourceForRepository: (repo: any, list: any[]) => {
    if (repo.sourceId) {
      const byId = list.find((source) => source.id === repo.sourceId);
      if (byId) return byId;
    }
    const normalized = "https://github.com";
    return (
      list.find(
        (candidate: any) =>
          candidate.provider === "github" && candidate.url === normalized
      ) ?? null
    );
  },
  decryptSourceToken: (token: string | null | undefined) => token ?? "",
  resolveGitHubApiBaseUrl: (url: string | null | undefined) => {
    const trimmed = url?.trim().replace(/\/+$/, "") ?? "";
    if (!trimmed || trimmed === "https://github.com") return undefined;
    return `${trimmed}/api/v3`;
  },
}));

const mockProcessWithResilience = mock(
  async (items: unknown[], worker: (item: unknown) => Promise<unknown>) => {
    const results: unknown[] = [];
    for (const item of items) {
      results.push(await worker(item));
    }
    return results;
  }
);

mock.module("@/lib/utils/concurrency", () => ({
  processWithResilience: mockProcessWithResilience,
}));

// drizzle-orm stays real: and/eq/inArray/sql happily build conditions over
// the mocked table stubs, and mocking the module would starve other modules
// in the import graph (they use operators like ilike).

mock.module("@/types/Repository", () => ({
  repoStatusEnum: {
    parse: mock((value: string) => value),
  },
}));

const { POST } = await import("./mirror-org");

type PostContext = Parameters<typeof POST>[0];

const postContext = (organizationIds: string[]): PostContext =>
  ({
    request: new Request("http://localhost/api/job/mirror-org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationIds }),
    }),
    locals: { session: { userId: "user-id" } },
  }) as PostContext;

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the mirror job to start");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Organization Mirroring API repository octokit resolver", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = mock(() => {});
    console.error = mock(() => {});
    mockCreateGitHubClient.mockClear();
    mockCreatePublicGitHubClient.mockClear();
    mockMirrorGitHubOrgToGitea.mockClear();
    mockProcessWithResilience.mockClear();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  const capturedResolver = async () => {
    const response = await POST(postContext(["org-id-1"]));
    expect(response.status).toBe(200);
    // The route fires the mirroring through setTimeout(…, 0); wait for the
    // mocked mirror entry point to receive the resolver.
    await waitFor(() => mockMirrorGitHubOrgToGitea.mock.calls.length > 0);
    return mockMirrorGitHubOrgToGitea.mock.calls[0][0]
      .resolveRepositoryOctokit as (repository: unknown) => unknown;
  };

  test("resolves an anonymous client for a repository from a tokenless GitHub source", async () => {
    const resolver = await capturedResolver();

    const client = resolver({
      id: "repo-public",
      name: "public-repo",
      fullName: "org-one/public-repo",
      owner: "org-one",
      sourceId: "source-github-public",
      sourceProvider: "github",
      sourceUrl: "https://github.com",
      cloneUrl: "https://github.com/org-one/public-repo.git",
    });

    // WP2: no source token, but still a GitHub source, so the resolver hands
    // back the anonymous public client (60 req/hr) instead of null — and
    // never calls createGitHubClient with an empty token.
    expect(client).toBe(anonymousClient);
    expect(mockCreatePublicGitHubClient).toHaveBeenCalledTimes(1);
    expect(mockCreatePublicGitHubClient.mock.calls[0]).toEqual([undefined]);
    expect(mockCreateGitHubClient).not.toHaveBeenCalled();
  });

  test("still resolves an authenticated client for a token-bearing GitHub source", async () => {
    const resolver = await capturedResolver();

    const client = resolver({
      id: "repo-token",
      name: "token-repo",
      fullName: "org-one/token-repo",
      owner: "org-one",
      sourceId: "source-github-token",
      sourceProvider: "github",
      sourceUrl: "https://github.example.com",
      cloneUrl: "https://github.example.com/org-one/token-repo.git",
    });

    expect(client).toBe(authenticatedClient);
    expect(mockCreateGitHubClient).toHaveBeenCalledTimes(1);
    expect(mockCreateGitHubClient.mock.calls[0]).toEqual([
      "source-token",
      "user-id",
      "tokenuser",
      "https://github.example.com/api/v3",
    ]);
    expect(mockCreatePublicGitHubClient).not.toHaveBeenCalled();
  });

  test("resolves null for a repository from a GitLab source", async () => {
    const resolver = await capturedResolver();

    const client = resolver({
      id: "repo-gitlab",
      name: "gitlab-repo",
      fullName: "org-one/gitlab-repo",
      owner: "org-one",
      sourceId: "source-gitlab",
      sourceProvider: "gitlab",
      sourceUrl: "https://gitlab.com",
      cloneUrl: "https://gitlab.com/org-one/gitlab-repo.git",
    });

    expect(client).toBeNull();
    expect(mockCreateGitHubClient).not.toHaveBeenCalled();
    expect(mockCreatePublicGitHubClient).not.toHaveBeenCalled();
  });

  test("accepts a config without a legacy GitHub token (public org mirroring)", async () => {
    // WP4: the route gate is destination-only. A public-org user has a
    // gitea token but no legacy GitHub token; the job must still start.
    const savedGithubConfig = mockConfigRow[0].githubConfig;
    mockConfigRow[0].githubConfig = { token: "" };
    mockMirrorGitHubOrgToGitea.mockClear();

    try {
      const response = await POST(postContext(["org-id-1"]));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      await waitFor(() => mockMirrorGitHubOrgToGitea.mock.calls.length > 0);
      expect(mockMirrorGitHubOrgToGitea).toHaveBeenCalledTimes(1);
    } finally {
      mockConfigRow[0].githubConfig = savedGithubConfig;
    }
  });
});
