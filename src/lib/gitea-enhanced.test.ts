import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createMockResponse, mockFetch } from "@/tests/mock-fetch";

// Mock the helpers module before importing gitea-enhanced
const mockCreateMirrorJob = mock(() => Promise.resolve("mock-job-id"));
mock.module("@/lib/helpers", () => ({
  createMirrorJob: mockCreateMirrorJob
}));

const mockMirrorGitHubReleasesToGitea = mock(() => Promise.resolve());
const mockMirrorGitRepoIssuesToGitea = mock(() => Promise.resolve());
const mockMirrorGitRepoPullRequestsToGitea = mock(() => Promise.resolve());
const mockMirrorGitRepoLabelsToGitea = mock(() => Promise.resolve());
const mockMirrorGitRepoMilestonesToGitea = mock(() => Promise.resolve());
const mockGetGiteaRepoOwnerAsync = mock(() => Promise.resolve("starred"));
const mockCreatePreSyncBundleBackup = mock(() =>
  Promise.resolve({ bundlePath: "/tmp/mock.bundle" })
);
let mockShouldCreatePreSyncBackup = false;
let mockShouldBlockSyncOnBackupFailure = true;

// Mock the database module. Every db.update(...).set(payload) is captured in
// dbUpdateSetCalls so tests can assert on what got written (e.g. archived
// repos keeping status "archived" after a Manual Sync).
const dbUpdateSetCalls: any[] = [];
const mockDb = {
  insert: mock((table: any) => ({
    values: mock((data: any) => Promise.resolve({ insertedId: "mock-id" }))
  })),
  update: mock(() => ({
    set: mock((data: any) => {
      dbUpdateSetCalls.push(data);
      return { where: mock(() => Promise.resolve()) };
    })
  }))
};

mock.module("@/lib/db", () => ({
  db: mockDb,
  users: {},
  configs: {},
  organizations: {},
  mirrorJobs: {},
  repositories: {},
  events: {},
  accounts: {},
  sessions: {},
}));

// Mock config encryption
mock.module("@/lib/utils/config-encryption", () => ({
  decryptConfigTokens: (config: any) => config,
  encryptConfigTokens: (config: any) => config,
  getDecryptedGitHubToken: (config: any) => config.githubConfig?.token || "",
  getDecryptedGiteaToken: (config: any) => config.giteaConfig?.token || ""
}));

// Mock http-client
class MockHttpError extends Error {
  constructor(message: string, public status: number, public statusText: string, public response?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

// Track call counts for org tests
let orgCheckCount = 0;
let orgTestContext = "";
let getOrgCalled = false;
let createOrgCalled = false;

const mockHttpGet = mock(async (url: string, headers?: any) => {
  // Return different responses based on URL patterns
  
  // Handle user authentication endpoint
  if (url.includes("/api/v1/user")) {
    return {
      data: {
        id: 1,
        login: "testuser",
        username: "testuser",
        email: "test@example.com",
        is_admin: false,
        full_name: "Test User"
      },
      status: 200,
      statusText: "OK",
      headers: new Headers()
    };
  }
  
  if (url.includes("/api/v1/repos/starred/test-repo")) {
    return { 
      data: { 
        id: 123, 
        name: "test-repo", 
        mirror: true, 
        owner: { login: "starred" },
        mirror_interval: "8h",
        clone_url: "https://github.com/user/test-repo.git",
        private: false
      },
      status: 200,
      statusText: "OK",
      headers: new Headers()
    };
  }
  if (url.includes("/api/v1/repos/starred/regular-repo")) {
    return { 
      data: { 
        id: 124, 
        name: "regular-repo", 
        mirror: false, 
        owner: { login: "starred" } 
      },
      status: 200,
      statusText: "OK",
      headers: new Headers()
    };
  }
  if (url.includes("/api/v1/repos/starred/non-mirror-repo")) {
    return { 
      data: { 
        id: 456, 
        name: "non-mirror-repo", 
        mirror: false, 
        owner: { login: "starred" },
        private: false
      },
      status: 200,
      statusText: "OK",
      headers: new Headers()
    };
  }
  if (url.includes("/api/v1/repos/starred/mirror-repo")) {
    return { 
      data: { 
        id: 789, 
        name: "mirror-repo", 
        mirror: true, 
        owner: { login: "starred" },
        mirror_interval: "8h",
        private: false
      },
      status: 200,
      statusText: "OK",
      headers: new Headers()
    };
  }
  if (url.includes("/api/v1/repos/starred/metadata-repo")) {
    return {
      data: {
        id: 790,
        name: "metadata-repo",
        mirror: true,
        owner: { login: "starred" },
        mirror_interval: "8h",
        private: false,
      },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    };
  }
  if (url.includes("/api/v1/repos/starred/already-synced-repo")) {
    return {
      data: {
        id: 791,
        name: "already-synced-repo",
        mirror: true,
        owner: { login: "starred" },
        mirror_interval: "8h",
        private: false,
      },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    };
  }
  // Only reachable at the "archived-{name}" candidate — the base name
  // ("starred/broken-repo") deliberately falls through to the generic 404
  // below, simulating a repo that archiveGiteaRepo already renamed in Gitea.
  // original_url matches the test repository's GitHub source, so the
  // fallback candidate's source-identity guard accepts it.
  if (url.includes("/api/v1/repos/starred/archived-broken-repo")) {
    return {
      data: {
        id: 792,
        name: "archived-broken-repo",
        mirror: true,
        owner: { login: "starred" },
        mirror_interval: "0h",
        original_url: "https://github.com/user/broken-repo.git",
        private: false,
      },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    };
  }
  // Collision scenario: this archived mirror belongs to a DIFFERENT GitHub
  // source (otheruser/collide-repo) that happens to share the base name with
  // the test repository (user/collide-repo). The base name
  // ("starred/collide-repo") falls through to the generic 404 below, so the
  // archived-{name} fallback candidate is the only match — and its
  // original_url must cause the source-identity guard to reject it.
  if (url.includes("/api/v1/repos/starred/archived-collide-repo")) {
    return {
      data: {
        id: 793,
        name: "archived-collide-repo",
        mirror: true,
        owner: { login: "starred" },
        mirror_interval: "0h",
        original_url: "https://github.com/otheruser/collide-repo.git",
        private: false,
      },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    };
  }
  // Simulates Forgejo silently following a 301 redirect for a renamed repo:
  // a GET for the STALE (pre-rename) path returns 200 with the repo's
  // CURRENT identity in the response body (name differs from what was
  // requested), exactly as Bun's fetch behaves after following Forgejo's
  // redirect for a repo renamed from "renamed-repo" to
  // "archived-renamed-repo". See #331 follow-up / canonical-identity
  // adoption in syncGiteaRepoEnhanced.
  if (url.includes("/api/v1/repos/starred/renamed-repo")) {
    return {
      data: {
        id: 891,
        name: "archived-renamed-repo",
        mirror: true,
        owner: { login: "starred" },
        private: false,
      },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    };
  }
  if (url.includes("/api/v1/repos/")) {
    throw new MockHttpError("Not Found", 404, "Not Found");
  }

  // Handle org GET requests based on test context
  if (url.includes("/api/v1/orgs/starred")) {
    orgCheckCount++;
    if (orgTestContext === "duplicate-retry" && orgCheckCount > 2) {
      // After retries, org exists
      return {
        data: { id: 999, username: "starred" },
        status: 200,
        statusText: "OK",
        headers: new Headers()
      };
    }
    // Otherwise, org doesn't exist
    throw new MockHttpError("Not Found", 404, "Not Found");
  }
  
  if (url.includes("/api/v1/orgs/neworg")) {
    getOrgCalled = true;
    // Org doesn't exist
    throw new MockHttpError("Not Found", 404, "Not Found");
  }
  
  return { data: {}, status: 200, statusText: "OK", headers: new Headers() };
});

const mockHttpPost = mock(async (url: string, body?: any, headers?: any) => {
  if (url.includes("/api/v1/orgs") && body?.username === "starred") {
    // Simulate duplicate org error
    throw new MockHttpError(
      'insert organization: pq: duplicate key value violates unique constraint "UQE_user_lower_name"',
      400,
      "Bad Request",
      JSON.stringify({ message: 'insert organization: pq: duplicate key value violates unique constraint "UQE_user_lower_name"', url: "https://gitea.example.com/api/swagger" })
    );
  }
  if (url.includes("/api/v1/orgs") && body?.username === "neworg") {
    createOrgCalled = true;
    return {
      data: { id: 777, username: "neworg" },
      status: 201,
      statusText: "Created",
      headers: new Headers()
    };
  }
  if (url.includes("/mirror-sync")) {
    return {
      data: { success: true },
      status: 200,
      statusText: "OK",
      headers: new Headers()
    };
  }
  return { data: {}, status: 200, statusText: "OK", headers: new Headers() };
});

const mockHttpDelete = mock(async (url: string, headers?: any) => {
  if (url.includes("/api/v1/repos/starred/test-repo")) {
    return { data: {}, status: 204, statusText: "No Content", headers: new Headers() };
  }
  return { data: {}, status: 200, statusText: "OK", headers: new Headers() };
});

// Observable so tests can assert that the mirror-interval PATCH is (not)
// issued — e.g. archived repos must never have Gitea's periodic pulling
// re-enabled by a Manual Sync.
const mockHttpPatch = mock(async (url: string, body?: any, headers?: any) => {
  return { data: {}, status: 200, statusText: "OK", headers: new Headers() };
});

mock.module("@/lib/http-client", () => ({
  httpGet: mockHttpGet,
  httpPost: mockHttpPost,
  httpDelete: mockHttpDelete,
  httpPatch: mockHttpPatch,
  HttpError: MockHttpError
}));

mock.module("@/lib/repo-backup", () => ({
  createPreSyncBundleBackup: mockCreatePreSyncBundleBackup,
  shouldCreatePreSyncBackup: () => mockShouldCreatePreSyncBackup,
  shouldBlockSyncOnBackupFailure: () => mockShouldBlockSyncOnBackupFailure,
}));

// Now import the modules we're testing
import { 
  getGiteaRepoInfo, 
  getOrCreateGiteaOrgEnhanced, 
  syncGiteaRepoEnhanced,
  handleExistingNonMirrorRepo 
} from "./gitea-enhanced";
import type { Config, Repository } from "./db/schema";
import { repoStatusEnum } from "@/types/Repository";

// Get HttpError from the mocked module
const { HttpError } = await import("@/lib/http-client");

describe("Enhanced Gitea Operations", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Clear mocks
    mockCreateMirrorJob.mockClear();
    mockDb.insert.mockClear();
    mockDb.update.mockClear();
    mockMirrorGitHubReleasesToGitea.mockClear();
    mockMirrorGitRepoIssuesToGitea.mockClear();
    mockMirrorGitRepoPullRequestsToGitea.mockClear();
    mockMirrorGitRepoLabelsToGitea.mockClear();
    mockMirrorGitRepoMilestonesToGitea.mockClear();
    mockGetGiteaRepoOwnerAsync.mockClear();
    mockGetGiteaRepoOwnerAsync.mockImplementation(() => Promise.resolve("starred"));
    mockHttpGet.mockClear();
    mockHttpPost.mockClear();
    mockHttpDelete.mockClear();
    mockHttpPatch.mockClear();
    dbUpdateSetCalls.length = 0;
    mockCreatePreSyncBundleBackup.mockClear();
    mockCreatePreSyncBundleBackup.mockImplementation(() =>
      Promise.resolve({ bundlePath: "/tmp/mock.bundle" })
    );
    mockShouldCreatePreSyncBackup = false;
    mockShouldBlockSyncOnBackupFailure = true;
    // Reset tracking variables
    orgCheckCount = 0;
    orgTestContext = "";
    getOrgCalled = false;
    createOrgCalled = false;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getGiteaRepoInfo", () => {
    test("should return repo info for existing mirror repository", async () => {
      global.fetch = mockFetch(() => 
        createMockResponse({
          id: 123,
          name: "test-repo",
          owner: "starred",
          mirror: true,
          mirror_interval: "8h",
          clone_url: "https://github.com/user/test-repo.git",
          private: false,
        })
      );

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: true,
        },
      };

      const repoInfo = await getGiteaRepoInfo({
        config,
        owner: "starred",
        repoName: "test-repo",
      });

      expect(repoInfo).toBeTruthy();
      expect(repoInfo?.mirror).toBe(true);
      expect(repoInfo?.name).toBe("test-repo");
    });

    test("should return repo info for existing non-mirror repository", async () => {
      global.fetch = mockFetch(() => 
        createMockResponse({
          id: 124,
          name: "regular-repo",
          owner: "starred",
          mirror: false,
          private: false,
        })
      );

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: true,
        },
      };

      const repoInfo = await getGiteaRepoInfo({
        config,
        owner: "starred",
        repoName: "regular-repo",
      });

      expect(repoInfo).toBeTruthy();
      expect(repoInfo?.mirror).toBe(false);
    });

    test("should return null for non-existent repository", async () => {
      global.fetch = mockFetch(() => 
        createMockResponse(
          "Not Found",
          { ok: false, status: 404, statusText: "Not Found" }
        )
      );

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: true,
        },
      };

      const repoInfo = await getGiteaRepoInfo({
        config,
        owner: "starred",
        repoName: "non-existent",
      });

      expect(repoInfo).toBeNull();
    });
  });

  describe("getOrCreateGiteaOrgEnhanced", () => {
    test("should handle duplicate organization constraint error with retry", async () => {
      orgTestContext = "duplicate-retry";
      orgCheckCount = 0; // Reset the count
      
      const config: Partial<Config> = {
        userId: "user123",
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          visibility: "public",
        },
      };

      const orgId = await getOrCreateGiteaOrgEnhanced({
        orgName: "starred",
        config,
        maxRetries: 3,
        retryDelay: 0, // No delay in tests
      });

      expect(orgId).toBe(999);
      expect(orgCheckCount).toBeGreaterThanOrEqual(3);
    });

    test("should create organization on first attempt", async () => {
      // Reset tracking variables
      getOrgCalled = false;
      createOrgCalled = false;

      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: true,
        },
      };

      const orgId = await getOrCreateGiteaOrgEnhanced({
        orgName: "neworg",
        config,
        retryDelay: 0, // No delay in tests
      });

      expect(orgId).toBe(777);
      expect(getOrgCalled).toBe(true);
      expect(createOrgCalled).toBe(true);
    });
  });

  describe("syncGiteaRepoEnhanced", () => {
    test("should fail gracefully when repository is not a mirror", async () => {
      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: true,
        },
      };

      const repository: Repository = {
        id: "repo123",
        name: "non-mirror-repo",
        fullName: "user/non-mirror-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/non-mirror-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("mirrored"),
        visibility: "public",
        userId: "user123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await expect(
        syncGiteaRepoEnhanced(
          { config, repository },
          {
            getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
            mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
            mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
            mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
            mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
            mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
          }
        )
      ).rejects.toThrow("Repository non-mirror-repo is not a mirror. Cannot sync.");

      expect(mockMirrorGitHubReleasesToGitea).not.toHaveBeenCalled();
    });

    test("should successfully sync a mirror repository", async () => {
      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: true,
        },
      };

      const repository: Repository = {
        id: "repo456",
        name: "mirror-repo",
        fullName: "user/mirror-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/mirror-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("mirrored"),
        visibility: "public",
        userId: "user123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await syncGiteaRepoEnhanced(
        { config, repository },
        {
          getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
          mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
          mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
          mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
          mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
          mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
        }
      );

      expect(result).toEqual({ success: true });
      expect(mockGetGiteaRepoOwnerAsync).toHaveBeenCalled();
      expect(mockMirrorGitHubReleasesToGitea).toHaveBeenCalledTimes(1);
      const releaseCall = mockMirrorGitHubReleasesToGitea.mock.calls[0][0];
      expect(releaseCall.giteaOwner).toBe("starred");
      expect(releaseCall.giteaRepoName).toBe("mirror-repo");
      expect(releaseCall.config.githubConfig?.token).toBe("github-token");
      expect(releaseCall.octokit).toBeDefined();
    });

    test("prefers recorded mirroredLocation when owner resolution changes", async () => {
      mockGetGiteaRepoOwnerAsync.mockImplementation(() => Promise.resolve("ceph"));

      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: true,
        },
      };

      const repository: Repository = {
        id: "repo789",
        name: "test-repo",
        fullName: "ceph/test-repo",
        owner: "ceph",
        cloneUrl: "https://github.com/ceph/test-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("mirrored"),
        visibility: "public",
        userId: "user123",
        mirroredLocation: "starred/test-repo",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await syncGiteaRepoEnhanced(
        { config, repository },
        {
          getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
          mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
          mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
          mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
          mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
          mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
        }
      );

      expect(result).toEqual({ success: true });

      const mirrorSyncCalls = mockHttpPost.mock.calls.filter((call) =>
        String(call[0]).includes("/mirror-sync")
      );
      expect(mirrorSyncCalls).toHaveLength(1);
      expect(String(mirrorSyncCalls[0][0])).toContain("/api/v1/repos/starred/test-repo/mirror-sync");
      expect(String(mirrorSyncCalls[0][0])).not.toContain("/api/v1/repos/ceph/test-repo/mirror-sync");
    });

    test("falls back to the archived-{name} candidate when repository.status is 'archived'", async () => {
      // Regression for #331 follow-up: repos archived before mirroredLocation
      // was backfilled on rename (or any lingering false-positive orphan hit)
      // are unreachable by name/expected-owner alone once archiveGiteaRepo has
      // renamed them in Gitea to `archived-{sanitized name}`. syncGiteaRepoEnhanced
      // must still find them via "Manual Sync" without manual intervention.
      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: false,
        },
      };

      const repository: Repository = {
        id: "repoArchived1",
        name: "broken-repo",
        fullName: "user/broken-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/broken-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("archived"),
        visibility: "public",
        userId: "user123",
        // No mirroredLocation recorded — this repo predates the DB backfill
        // added alongside archiveGiteaRepo's new return value.
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await syncGiteaRepoEnhanced(
        { config, repository },
        {
          getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
          mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
          mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
          mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
          mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
          mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
        }
      );

      expect(result).toEqual({ success: true });

      const mirrorSyncCalls = mockHttpPost.mock.calls.filter((call) =>
        String(call[0]).includes("/mirror-sync")
      );
      expect(mirrorSyncCalls).toHaveLength(1);
      expect(String(mirrorSyncCalls[0][0])).toContain(
        "/api/v1/repos/starred/archived-broken-repo/mirror-sync"
      );
      // The base (pre-archive) name must have been probed and rejected
      // (404) before falling back to the archived-{name} candidate.
      const repoInfoGets = mockHttpGet.mock.calls.filter((call) =>
        String(call[0]).includes("/api/v1/repos/starred/")
      );
      expect(
        repoInfoGets.some((call) =>
          String(call[0]).endsWith("/api/v1/repos/starred/broken-repo")
        )
      ).toBe(true);
      expect(
        repoInfoGets.some((call) =>
          String(call[0]).endsWith("/api/v1/repos/starred/archived-broken-repo")
        )
      ).toBe(true);
    });

    test("adopts canonical identity from response body when GET follows a stale-name redirect", async () => {
      // Regression for #331 follow-up, verified end-to-end on Forgejo 15.0.3:
      // when a repo has been renamed (e.g. by the orphan-archive flow, or
      // manually by a user), Forgejo answers a GET for the OLD name with a
      // 301 redirect to the new name. Bun's fetch follows it silently and
      // returns 200 with the repo's CURRENT data in the body, while the
      // code still has the stale name it requested. If syncGiteaRepoEnhanced
      // kept using the requested (stale) name for the follow-up POST
      // .../mirror-sync, that POST would hit the same 301, get its method
      // downgraded to GET per the WHATWG redirect spec, and the POST-only
      // endpoint would return 405. This must work for non-archived repos
      // too — a user renaming a repo in Forgejo manually is the general case.
      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: false,
        },
      };

      const repository: Repository = {
        id: "repoRenamed1",
        name: "renamed-repo",
        fullName: "user/renamed-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/renamed-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("mirrored"),
        visibility: "public",
        userId: "user123",
        // Stale: recorded before the rename happened in Gitea/Forgejo.
        mirroredLocation: "starred/renamed-repo",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await syncGiteaRepoEnhanced(
        { config, repository },
        {
          getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
          mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
          mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
          mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
          mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
          mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
        }
      );

      expect(result).toEqual({ success: true });

      const mirrorSyncCalls = mockHttpPost.mock.calls.filter((call) =>
        String(call[0]).includes("/mirror-sync")
      );
      expect(mirrorSyncCalls).toHaveLength(1);
      expect(String(mirrorSyncCalls[0][0])).toContain(
        "/api/v1/repos/starred/archived-renamed-repo/mirror-sync"
      );
      expect(String(mirrorSyncCalls[0][0])).not.toContain(
        "/api/v1/repos/starred/renamed-repo/mirror-sync"
      );
    });

    test("keeps archived repos archived and skips the mirror-interval PATCH on Manual Sync", async () => {
      // Documented contract (AutomationSettings.tsx): "Archive renames mirror
      // backups with an archived- prefix and disables automatic syncs—use
      // Manual Sync when you want to refresh." A successful Manual Sync of an
      // archived repo must therefore refresh once WITHOUT (a) flipping status
      // to "synced" (which would re-enroll it into the scheduler's auto-sync
      // pool), (b) clearing the archived errorMessage annotation, or
      // (c) PATCHing the mirror interval (which would re-enable Forgejo's own
      // periodic pulling that archiveGiteaRepo disabled).
      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: false,
          // Would normally trigger the mirror-interval PATCH on every sync.
          mirrorInterval: "8h",
        },
      };

      const repository: Repository = {
        id: "repoArchived2",
        name: "broken-repo",
        fullName: "user/broken-repo",
        owner: "user",
        url: "https://github.com/user/broken-repo",
        cloneUrl: "https://github.com/user/broken-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("archived"),
        isArchived: true,
        visibility: "public",
        userId: "user123",
        errorMessage: "Repository archived - no longer in GitHub",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await syncGiteaRepoEnhanced(
        { config, repository },
        {
          getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
          mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
          mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
          mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
          mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
          mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
        }
      );

      expect(result).toEqual({ success: true });

      // The mirror-sync itself must still happen (that's the point of
      // Manual Sync on an archived repo).
      const mirrorSyncCalls = mockHttpPost.mock.calls.filter((call) =>
        String(call[0]).includes("/mirror-sync")
      );
      expect(mirrorSyncCalls).toHaveLength(1);
      expect(String(mirrorSyncCalls[0][0])).toContain(
        "/api/v1/repos/starred/archived-broken-repo/mirror-sync"
      );

      // No mirror-interval PATCH despite config.giteaConfig.mirrorInterval.
      expect(mockHttpPatch).not.toHaveBeenCalled();

      // The success-path DB update (the one recording lastMirrored) keeps
      // status "archived" and does not clear errorMessage.
      const successUpdate = dbUpdateSetCalls.find((data) => "lastMirrored" in data);
      expect(successUpdate).toBeDefined();
      expect(successUpdate.status).toBe("archived");
      expect("errorMessage" in successUpdate).toBe(false);
      expect(successUpdate.mirroredLocation).toBe("starred/archived-broken-repo");
    });

    test("rejects an archived-{name} fallback candidate whose original_url points at a different source", async () => {
      // Two sources sharing a base name: the user mirrors user/collide-repo,
      // but starred/archived-collide-repo in Gitea is the archived mirror of
      // otheruser/collide-repo. The guessed archived-{name} fallback must be
      // rejected via its original_url instead of syncing (and rewriting the
      // DB row of) the wrong repository. With every candidate exhausted, the
      // sync fails with the not-found error.
      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: false,
        },
      };

      const repository: Repository = {
        id: "repoCollide1",
        name: "collide-repo",
        fullName: "user/collide-repo",
        owner: "user",
        url: "https://github.com/user/collide-repo",
        cloneUrl: "https://github.com/user/collide-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("archived"),
        isArchived: true,
        visibility: "public",
        userId: "user123",
        // No mirroredLocation — forces reliance on the guessed fallback.
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await expect(
        syncGiteaRepoEnhanced(
          { config, repository },
          {
            getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
            mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
            mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
            mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
            mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
            mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
          }
        )
      ).rejects.toThrow("Repository collide-repo not found in Gitea. Tried locations:");

      // The wrong repo must never receive a mirror-sync POST.
      const mirrorSyncCalls = mockHttpPost.mock.calls.filter((call) =>
        String(call[0]).includes("/mirror-sync")
      );
      expect(mirrorSyncCalls).toHaveLength(0);
      // The fallback candidate WAS probed (and then rejected by the guard).
      expect(
        mockHttpGet.mock.calls.some((call) =>
          String(call[0]).endsWith("/api/v1/repos/starred/archived-collide-repo")
        )
      ).toBe(true);
    });

    test("blocks sync when pre-sync snapshot fails and blocking is enabled", async () => {
      mockShouldCreatePreSyncBackup = true;
      mockShouldBlockSyncOnBackupFailure = true;
      mockCreatePreSyncBundleBackup.mockImplementation(() =>
        Promise.reject(new Error("simulated backup failure"))
      );

      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: false,
          backupStrategy: "always",
          blockSyncOnBackupFailure: true,
        },
      };

      const repository: Repository = {
        id: "repo456",
        name: "mirror-repo",
        fullName: "user/mirror-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/mirror-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("mirrored"),
        visibility: "public",
        userId: "user123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await expect(
        syncGiteaRepoEnhanced(
          { config, repository },
          {
            getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
            mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
            mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
            mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
            mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
            mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
          }
        )
      ).rejects.toThrow("Snapshot failed; sync blocked to protect history.");

      const mirrorSyncCalls = mockHttpPost.mock.calls.filter((call) =>
        String(call[0]).includes("/mirror-sync")
      );
      expect(mirrorSyncCalls.length).toBe(0);
    });

    test("continues sync when pre-sync snapshot fails and blocking is disabled", async () => {
      mockShouldCreatePreSyncBackup = true;
      mockShouldBlockSyncOnBackupFailure = false;
      mockCreatePreSyncBundleBackup.mockImplementation(() =>
        Promise.reject(new Error("simulated backup failure"))
      );

      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: false,
          mirrorStarred: true,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: false,
          backupBeforeSync: true,
          blockSyncOnBackupFailure: false,
        },
      };

      const repository: Repository = {
        id: "repo457",
        name: "mirror-repo",
        fullName: "user/mirror-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/mirror-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("mirrored"),
        visibility: "public",
        userId: "user123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await syncGiteaRepoEnhanced(
        { config, repository },
        {
          getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
          mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
          mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
          mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
          mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
          mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
        }
      );

      expect(result).toEqual({ success: true });
      const mirrorSyncCalls = mockHttpPost.mock.calls.filter((call) =>
        String(call[0]).includes("/mirror-sync")
      );
      expect(mirrorSyncCalls.length).toBe(1);
    });

    test("mirrors metadata components when enabled and not previously synced", async () => {
      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: true,
          mirrorStarred: false,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: true,
          mirrorMetadata: true,
          mirrorIssues: true,
          mirrorPullRequests: true,
          mirrorLabels: true,
          mirrorMilestones: true,
        },
      };

      const repository: Repository = {
        id: "repo789",
        name: "metadata-repo",
        fullName: "user/metadata-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/metadata-repo.git",
        isPrivate: false,
        isStarred: false,
        status: repoStatusEnum.parse("mirrored"),
        visibility: "public",
        userId: "user123",
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      };

      await syncGiteaRepoEnhanced(
        { config, repository },
        {
          getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
          mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
          mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
          mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
          mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
          mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
        }
      );

      expect(mockMirrorGitHubReleasesToGitea).toHaveBeenCalledTimes(1);
      expect(mockMirrorGitRepoIssuesToGitea).toHaveBeenCalledTimes(1);
      expect(mockMirrorGitRepoPullRequestsToGitea).toHaveBeenCalledTimes(1);
      expect(mockMirrorGitRepoMilestonesToGitea).toHaveBeenCalledTimes(1);
      // Labels should be skipped because issues already import them
      expect(mockMirrorGitRepoLabelsToGitea).not.toHaveBeenCalled();
    });

    test("skips issues and PRs when metadata shows they were already synced", async () => {
      const config: Partial<Config> = {
        userId: "user123",
        githubConfig: {
          username: "testuser",
          token: "github-token",
          privateRepositories: true,
          mirrorStarred: false,
        },
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
          mirrorReleases: false,
          mirrorMetadata: true,
          mirrorIssues: true,
          mirrorPullRequests: true,
          mirrorLabels: true,
          mirrorMilestones: true,
        },
      };

      const repository: Repository = {
        id: "repo790",
        name: "already-synced-repo",
        fullName: "user/already-synced-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/already-synced-repo.git",
        isPrivate: false,
        isStarred: false,
        status: repoStatusEnum.parse("mirrored"),
        visibility: "public",
        userId: "user123",
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({
          components: {
            releases: true,
            issues: true,
            pullRequests: true,
            labels: true,
            milestones: true,
          },
          lastSyncedAt: new Date().toISOString(),
        }),
      };

      await syncGiteaRepoEnhanced(
        { config, repository },
        {
          getGiteaRepoOwnerAsync: mockGetGiteaRepoOwnerAsync,
          mirrorGitHubReleasesToGitea: mockMirrorGitHubReleasesToGitea,
          mirrorGitRepoIssuesToGitea: mockMirrorGitRepoIssuesToGitea,
          mirrorGitRepoPullRequestsToGitea: mockMirrorGitRepoPullRequestsToGitea,
          mirrorGitRepoLabelsToGitea: mockMirrorGitRepoLabelsToGitea,
          mirrorGitRepoMilestonesToGitea: mockMirrorGitRepoMilestonesToGitea,
        }
      );

      // Metadata reconciliation now runs on every sync (mirror* functions
      // are idempotent and PATCH existing entries by marker/name/title).
      // Releases are still skipped here because the flag is off in this config.
      // Labels are still skipped because the issues path also handles labels.
      expect(mockMirrorGitHubReleasesToGitea).not.toHaveBeenCalled();
      expect(mockMirrorGitRepoIssuesToGitea).toHaveBeenCalledTimes(1);
      expect(mockMirrorGitRepoPullRequestsToGitea).toHaveBeenCalledTimes(1);
      expect(mockMirrorGitRepoLabelsToGitea).not.toHaveBeenCalled();
      expect(mockMirrorGitRepoMilestonesToGitea).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleExistingNonMirrorRepo", () => {
    test("should skip non-mirror repository with skip strategy", async () => {
      const repoInfo = {
        id: 123,
        name: "test-repo",
        owner: "starred",
        mirror: false,
        private: false,
      };

      const repository: Repository = {
        id: "repo123",
        name: "test-repo",
        fullName: "user/test-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/test-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("imported"),
        visibility: "public",
        userId: "user123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
        },
      };

      await handleExistingNonMirrorRepo({
        config,
        repository,
        repoInfo,
        strategy: "skip",
      });

      // Test passes if no error is thrown
      expect(true).toBe(true);
    });

    test("should delete non-mirror repository with delete strategy", async () => {
      // Mock deleteGiteaRepo which uses httpDelete via the http-client mock
      const repoInfo = {
        id: 124,
        name: "test-repo",
        owner: "starred",
        mirror: false,
        private: false,
      };

      const repository: Repository = {
        id: "repo124",
        name: "test-repo",
        fullName: "user/test-repo",
        owner: "user",
        cloneUrl: "https://github.com/user/test-repo.git",
        isPrivate: false,
        isStarred: true,
        status: repoStatusEnum.parse("imported"),
        visibility: "public",
        userId: "user123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
        },
      };

      // deleteGiteaRepo in the actual code uses fetch directly, not httpDelete
      // We need to mock fetch for this test
      let deleteCalled = false;
      global.fetch = mockFetch(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/repos/starred/test-repo") && options?.method === "DELETE") {
          deleteCalled = true;
          return createMockResponse(null, { ok: true, status: 204 });
        }
        return createMockResponse(null, { ok: false, status: 404 });
      });

      await handleExistingNonMirrorRepo({
        config,
        repository,
        repoInfo,
        strategy: "delete",
      });

      expect(deleteCalled).toBe(true);
    });
  });
});
