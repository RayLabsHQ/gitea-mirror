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

// Mock the database module
const mockDb = {
  insert: mock((table: any) => ({
    values: mock((data: any) => Promise.resolve({ insertedId: "mock-id" }))
  })),
  update: mock(() => ({
    set: mock(() => ({
      where: mock(() => Promise.resolve())
    }))
  }))
};

mock.module("@/lib/db", () => ({
  db: mockDb,
  mirrorJobs: {},
  repositories: {}
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

mock.module("@/lib/http-client", () => ({
  httpGet: mockHttpGet,
  httpPost: mockHttpPost,
  httpDelete: mockHttpDelete,
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
          backupBeforeSync: true,
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

    test("continues incremental issue and PR syncing when metadata was previously synced", async () => {
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

      expect(mockMirrorGitHubReleasesToGitea).not.toHaveBeenCalled();
      expect(mockMirrorGitRepoIssuesToGitea).toHaveBeenCalledTimes(1);
      expect(mockMirrorGitRepoPullRequestsToGitea).toHaveBeenCalledTimes(1);
      expect(mockMirrorGitRepoLabelsToGitea).not.toHaveBeenCalled();
      expect(mockMirrorGitRepoMilestonesToGitea).not.toHaveBeenCalled();
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
