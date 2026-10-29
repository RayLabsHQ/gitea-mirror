/**
 * Route tests for GET /api/repositories/:id/releases.
 *
 * The release-rule editor judges its draft filters against whatever this route
 * reports, so the two things that matter are the owner the releases are read
 * from and the list that comes back. The destination itself is driven through a
 * fake fetch, which is what the shared HTTP client uses.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createMockResponse, mockFetch } from "@/tests/mock-fetch";

const CHILD_FLAG = "GM_RELEASES_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("repositories [id] releases route — isolated child suite", () => {
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

let repoRows: any[] = [];
let configRows: any[] = [];
const mockRepositories = {};
const mockConfigs = {};

const mockDb = {
  select: mock(() => ({
    from: mock((table: any) => ({
      where: mock(() => ({
        limit: mock(() => Promise.resolve(table === mockConfigs ? configRows : repoRows)),
      })),
    })),
  })),
};

// bun's mock.module is process-wide and leaks into other test files, so in the
// shared test process this file registers nothing: it re-runs itself in an
// isolated child process (the same harness as organizations/[id].test.ts).
const mockGetOwner = mock(async () => "mirrors");

if (isChild) {
  // The route pulls in the auth module, which imports every table, so the
  // mock has to name them all.
  mock.module("@/lib/db", () => ({
    db: mockDb,
    repositories: mockRepositories,
    configs: mockConfigs,
    organizations: {},
    users: {},
    mirrorJobs: {},
    events: {},
    accounts: {},
    sessions: {},
    verificationTokens: {},
    verifications: {},
    oauthClients: {},
    oauthAccessTokens: {},
    oauthRefreshTokens: {},
    oauthConsents: {},
    jwkss: {},
    ssoProviders: {},
    apikeys: {},
    rateLimits: {},
  }));

  // Only the owner lookup is needed from the destination client; the releases
  // themselves arrive through the fake fetch below.
  mock.module("@/lib/gitea", () => ({
    getGiteaRepoOwnerAsync: mockGetOwner,
    getGiteaRepoOwner: () => "mirrors",
  }));
}

const { GET } = isChild
  ? await import("./releases")
  : { GET: undefined as any };

const repoRow = {
  id: "r1",
  userId: "user-1",
  name: "hello",
  fullName: "octocat/hello",
  owner: "octocat",
  organization: null,
  isStarred: false,
  destinationOrg: null,
  mirroredLocation: "mirrors/hello",
  status: "mirrored",
  destinationProvider: "gitea",
  destinationUrl: "https://gitea.example.com",
};

const configRow = {
  id: "c1",
  userId: "user-1",
  isActive: true,
  githubConfig: { token: "gh", owner: "octocat", mirrorStrategy: "preserve" },
  giteaConfig: {
    url: "https://gitea.example.com",
    token: "gitea-token",
    defaultOwner: "me",
    provider: "gitea",
  },
};

const realFetch = globalThis.fetch;
let requestedUrls: string[] = [];

/** Serve one response per page, in order. */
function servePages(pages: unknown[]) {
  requestedUrls = [];
  let index = 0;
  globalThis.fetch = mockFetch(async (url: string) => {
    requestedUrls.push(url);
    const batch = pages[index++];
    return batch instanceof Response ? batch : createMockResponse(batch);
  }) as unknown as typeof globalThis.fetch;
}

function batch(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    tag_name: `v${offset + i}`,
    prerelease: false,
  }));
}

function call(id = "r1") {
  return GET({
    params: { id },
    request: new Request(`http://localhost/api/repositories/${id}/releases`),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  repoRows = [repoRow];
  configRows = [configRow];
  mockGetOwner.mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe.skipIf(!isChild)("GET /api/repositories/:id/releases", () => {
  test("reads the destination at the place the mirror was put", async () => {
    servePages([
      [
        { tag_name: "v1.0", prerelease: false },
        { tag_name: "v2.0-rc1", prerelease: true },
      ],
    ]);

    const response = await call();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.destination).toBe("mirrors/hello");
    expect(data.releases).toEqual([
      { tag: "v1.0", prerelease: false },
      { tag: "v2.0-rc1", prerelease: true },
    ]);
    expect(requestedUrls[0]).toContain("/api/v1/repos/mirrors/hello/releases");
    expect(requestedUrls[0]).toContain("limit=50&page=1");
    expect(mockGetOwner).not.toHaveBeenCalled();
  });

  test("resolves the owner the way a sync would before the mirror is placed", async () => {
    repoRows = [{ ...repoRow, mirroredLocation: null }];
    servePages([[]]);

    const response = await call();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.destination).toBe("mirrors/hello");
    expect(data.releases).toEqual([]);
    expect(mockGetOwner).toHaveBeenCalledTimes(1);
    expect(requestedUrls[0]).toContain("/api/v1/repos/mirrors/hello/releases");
  });

  test("answers 404 for a repository that is not the account's", async () => {
    repoRows = [];
    servePages([[]]);

    const response = await call();
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(requestedUrls).toHaveLength(0);
  });

  test("refuses before the destination is configured", async () => {
    configRows = [
      { ...configRow, giteaConfig: { url: "", token: "", defaultOwner: "" } },
    ];
    servePages([[]]);

    const response = await call();
    expect(response.status).toBe(400);
    expect(requestedUrls).toHaveLength(0);
  });

  test("says which destination could not be read", async () => {
    servePages([
      createMockResponse({ message: "not found" }, { ok: false, status: 404, statusText: "Not Found" }),
    ]);

    const response = await call();
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain("mirrors/hello");
  });

  test("follows the destination paging until a short page", async () => {
    servePages([batch(100), batch(2, 100)]);

    const response = await call();
    const data = await response.json();
    expect(data.releases).toHaveLength(102);
    expect(data.truncated).toBe(false);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toContain("page=2");
  });

  test("keeps paging while the destination's total says more remain", async () => {
    // Gitea caps pages below what was asked for and reports the total.
    const page = (count: number, offset: number) =>
      new Response(JSON.stringify(batch(count, offset)), {
        headers: { "content-type": "application/json", "x-total-count": "35" },
      });
    servePages([page(30, 0), page(5, 30)]);

    const response = await call();
    const data = await response.json();
    expect(data.releases).toHaveLength(35);
    expect(data.truncated).toBe(false);
    expect(requestedUrls).toHaveLength(2);
  });

  test("stops at the cap and marks the list as shortened", async () => {
    servePages([batch(100), batch(100, 100), batch(100, 200), batch(1, 300)]);

    const response = await call();
    const data = await response.json();
    expect(data.releases).toHaveLength(300);
    expect(data.truncated).toBe(true);
    expect(requestedUrls).toHaveLength(3);
  });
});
