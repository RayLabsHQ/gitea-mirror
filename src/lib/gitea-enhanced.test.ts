import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { 
  getGiteaRepoInfo, 
  getOrCreateGiteaOrgEnhanced, 
  syncGiteaRepoEnhanced,
  handleExistingNonMirrorRepo 
} from "./gitea-enhanced";
import { HttpError } from "./http-client";
import type { Config, Repository } from "./db/schema";
import { repoStatusEnum } from "@/types/Repository";

describe("Enhanced Gitea Operations", () => {
  let originalFetch: typeof global.fetch;
  let mockDb: any;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Mock database operations
    mockDb = {
      update: mock(() => ({
        set: mock(() => ({
          where: mock(() => Promise.resolve()),
        })),
      })),
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getGiteaRepoInfo", () => {
    test("should return repo info for existing mirror repository", async () => {
      global.fetch = mock(async (url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: 123,
          name: "test-repo",
          owner: "starred",
          mirror: true,
          mirror_interval: "8h",
          clone_url: "https://github.com/user/test-repo.git",
          private: false,
        }),
      }));

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
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
      global.fetch = mock(async (url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: 124,
          name: "regular-repo",
          owner: "starred",
          mirror: false,
          private: false,
        }),
      }));

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
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
      global.fetch = mock(async (url: string) => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "Not Found",
      }));

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
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
      let attemptCount = 0;
      
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        attemptCount++;
        
        if (url.includes("/api/v1/orgs/starred") && options?.method !== "POST") {
          // First two attempts: org doesn't exist
          if (attemptCount <= 2) {
            return {
              ok: false,
              status: 404,
              statusText: "Not Found",
            };
          }
          // Third attempt: org now exists (created by another process)
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ id: 999, username: "starred" }),
          };
        }

        if (url.includes("/api/v1/orgs") && options?.method === "POST") {
          // Simulate duplicate constraint error
          return {
            ok: false,
            status: 422,
            statusText: "Unprocessable Entity",
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ 
              message: "pq: duplicate key value violates unique constraint \"UQE_user_lower_name\"" 
            }),
            text: async () => "duplicate key value violates unique constraint",
          };
        }

        return { ok: false, status: 500 };
      });

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
        retryDelay: 10,
      });

      expect(orgId).toBe(999);
      expect(attemptCount).toBeGreaterThanOrEqual(3);
    });

    test("should create organization on first attempt", async () => {
      let getOrgCalled = false;
      let createOrgCalled = false;

      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/orgs/neworg") && options?.method !== "POST") {
          getOrgCalled = true;
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
          };
        }

        if (url.includes("/api/v1/orgs") && options?.method === "POST") {
          createOrgCalled = true;
          return {
            ok: true,
            status: 201,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ id: 777, username: "neworg" }),
          };
        }

        return { ok: false, status: 500 };
      });

      const config: Partial<Config> = {
        userId: "user123",
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
        },
      };

      const orgId = await getOrCreateGiteaOrgEnhanced({
        orgName: "neworg",
        config,
      });

      expect(orgId).toBe(777);
      expect(getOrgCalled).toBe(true);
      expect(createOrgCalled).toBe(true);
    });
  });

  describe("syncGiteaRepoEnhanced", () => {
    test("should fail gracefully when repository is not a mirror", async () => {
      global.fetch = mock(async (url: string) => {
        if (url.includes("/api/v1/repos/starred/non-mirror-repo") && !url.includes("mirror-sync")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              id: 456,
              name: "non-mirror-repo",
              owner: "starred",
              mirror: false, // Not a mirror
              private: false,
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const config: Partial<Config> = {
        userId: "user123",
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
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

      // Mock getGiteaRepoOwnerAsync
      const mockGetOwner = mock(() => Promise.resolve("starred"));
      global.import = mock(async (path: string) => {
        if (path === "./gitea") {
          return { getGiteaRepoOwnerAsync: mockGetOwner };
        }
        return {};
      }) as any;

      await expect(
        syncGiteaRepoEnhanced({ config, repository })
      ).rejects.toThrow("Repository non-mirror-repo is not a mirror. Cannot sync.");
    });

    test("should successfully sync a mirror repository", async () => {
      let syncCalled = false;

      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/repos/starred/mirror-repo") && !url.includes("mirror-sync")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              id: 789,
              name: "mirror-repo",
              owner: "starred",
              mirror: true,
              mirror_interval: "8h",
              private: false,
            }),
          };
        }

        if (url.includes("/mirror-sync") && options?.method === "POST") {
          syncCalled = true;
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ success: true }),
          };
        }

        return { ok: false, status: 404 };
      });

      const config: Partial<Config> = {
        userId: "user123",
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "encrypted-token",
          defaultOwner: "testuser",
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

      // Mock getGiteaRepoOwnerAsync
      const mockGetOwner = mock(() => Promise.resolve("starred"));
      global.import = mock(async (path: string) => {
        if (path === "./gitea") {
          return { getGiteaRepoOwnerAsync: mockGetOwner };
        }
        return {};
      }) as any;

      const result = await syncGiteaRepoEnhanced({ config, repository });

      expect(result).toEqual({ success: true });
      expect(syncCalled).toBe(true);
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
        status: repoStatusEnum.parse("pending"),
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
      let deleteCalled = false;

      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/repos/starred/test-repo") && options?.method === "DELETE") {
          deleteCalled = true;
          return {
            ok: true,
            status: 204,
          };
        }
        return { ok: false, status: 404 };
      });

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
        status: repoStatusEnum.parse("pending"),
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
        strategy: "delete",
      });

      expect(deleteCalled).toBe(true);
    });
  });
});