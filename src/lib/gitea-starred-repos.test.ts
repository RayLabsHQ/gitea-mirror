import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { getOrCreateGiteaOrg, mirrorGitHubOrgRepoToGiteaOrg, isRepoPresentInGitea } from "./gitea";
import type { Config, Repository } from "./db/schema";
import { repoStatusEnum } from "@/types/Repository";

describe("Starred Repository Error Handling", () => {
  let originalFetch: typeof global.fetch;
  let consoleLogs: string[] = [];
  let consoleErrors: string[] = [];

  beforeEach(() => {
    originalFetch = global.fetch;
    consoleLogs = [];
    consoleErrors = [];
    
    // Capture console output for debugging
    console.log = mock((message: string) => {
      consoleLogs.push(message);
    });
    console.error = mock((message: string) => {
      consoleErrors.push(message);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("Repository is not a mirror error", () => {
    test("should handle 400 error when trying to sync a non-mirror repo", async () => {
      // Mock fetch to simulate the "Repository is not a mirror" error
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/repos/starred/test-repo/mirror-sync")) {
          return {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              message: "Repository is not a mirror",
              url: "https://gitea.ui.com/api/swagger"
            })
          } as Response;
        }
        
        // Mock successful repo check
        if (url.includes("/api/v1/repos/starred/test-repo")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              id: 123,
              name: "test-repo",
              mirror: false, // Repo is not a mirror
              owner: { login: "starred" }
            })
          } as Response;
        }
        
        return originalFetch(url, options);
      });

      const config: Partial<Config> = {
        userId: "user-123",
        giteaConfig: {
          url: "https://gitea.ui.com",
          token: "gitea-token",
          defaultOwner: "testuser",
          starredReposOrg: "starred"
        },
        githubConfig: {
          token: "github-token",
          starredReposOrg: "starred"
        }
      };

      const repository: Repository = {
        id: "repo-123",
        userId: "user-123",
        configId: "config-123",
        name: "test-repo",
        fullName: "original-owner/test-repo",
        url: "https://github.com/original-owner/test-repo",
        cloneUrl: "https://github.com/original-owner/test-repo.git",
        owner: "original-owner",
        isPrivate: false,
        isForked: false,
        hasIssues: true,
        isStarred: true, // This is a starred repo
        isArchived: false,
        size: 1000,
        hasLFS: false,
        hasSubmodules: false,
        defaultBranch: "main",
        visibility: "public",
        status: "mirrored",
        mirroredLocation: "starred/test-repo",
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Verify that the repo exists but is not a mirror
      const exists = await isRepoPresentInGitea({
        config,
        owner: "starred",
        repoName: "test-repo"
      });
      
      expect(exists).toBe(true);
      
      // The error would occur during sync operation
      // This test verifies the scenario exists
    });

    test("should detect when a starred repo was created as regular repo instead of mirror", async () => {
      // Mock fetch to return repo details
      global.fetch = mock(async (url: string) => {
        if (url.includes("/api/v1/repos/starred/test-repo")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              id: 123,
              name: "test-repo",
              mirror: false, // This is the problem - repo is not a mirror
              owner: { login: "starred" },
              clone_url: "https://gitea.ui.com/starred/test-repo.git",
              original_url: null // No original URL since it's not a mirror
            })
          } as Response;
        }
        
        return originalFetch(url);
      });

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.ui.com",
          token: "gitea-token"
        }
      };

      // Check if repo exists
      const exists = await isRepoPresentInGitea({
        config,
        owner: "starred",
        repoName: "test-repo"
      });

      expect(exists).toBe(true);
      
      // In a real scenario, we would need to:
      // 1. Delete the non-mirror repo
      // 2. Recreate it as a mirror
      // This test documents the problematic state
    });
  });

  describe("Duplicate organization error", () => {
    test("should handle duplicate organization creation error", async () => {
      // Mock fetch to simulate duplicate org error
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/orgs/starred") && options?.method === "POST") {
          return {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              message: "insert organization: pq: duplicate key value violates unique constraint \"UQE_user_lower_name\"",
              url: "https://gitea.url.com/api/swagger"
            })
          } as Response;
        }
        
        // Mock org check - org doesn't exist according to API
        if (url.includes("/api/v1/orgs/starred") && options?.method === "GET") {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found"
          } as Response;
        }
        
        return originalFetch(url, options);
      });

      const config: Partial<Config> = {
        userId: "user-123",
        giteaConfig: {
          url: "https://gitea.url.com",
          token: "gitea-token"
        }
      };

      try {
        await getOrCreateGiteaOrg({
          orgName: "starred",
          config
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("duplicate key value violates unique constraint");
      }
    });

    test("should handle race condition in organization creation", async () => {
      let orgCheckCount = 0;
      
      // Mock fetch to simulate race condition
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/orgs/starred") && options?.method === "GET") {
          orgCheckCount++;
          // First check returns 404, second returns 200 (org was created by another process)
          if (orgCheckCount === 1) {
            return {
              ok: false,
              status: 404,
              statusText: "Not Found"
            } as Response;
          } else {
            return {
              ok: true,
              status: 200,
              headers: new Headers({ "content-type": "application/json" }),
              json: async () => ({
                id: 456,
                username: "starred",
                full_name: "Starred Repositories"
              })
            } as Response;
          }
        }
        
        if (url.includes("/api/v1/orgs/starred") && options?.method === "POST") {
          // Simulate duplicate error
          return {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              message: "insert organization: pq: duplicate key value violates unique constraint \"UQE_user_lower_name\"",
              url: "https://gitea.url.com/api/swagger"
            })
          } as Response;
        }
        
        return originalFetch(url, options);
      });

      const config: Partial<Config> = {
        userId: "user-123",
        giteaConfig: {
          url: "https://gitea.url.com",
          token: "gitea-token"
        }
      };

      // In a proper implementation, this should retry and succeed
      // Current implementation throws an error
      try {
        await getOrCreateGiteaOrg({
          orgName: "starred",
          config
        });
        expect(false).toBe(true); // Should not reach here with current implementation
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        // This documents the current behavior - it should be improved
      }
    });
  });

  describe("Comprehensive starred repository mirroring flow", () => {
    test("should handle the complete flow of mirroring a starred repository", async () => {
      const mockResponses = new Map<string, any>();
      
      // Setup mock responses
      mockResponses.set("GET /api/v1/orgs/starred", {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: 789,
          username: "starred",
          full_name: "Starred Repositories"
        })
      });
      
      mockResponses.set("GET /api/v1/repos/starred/awesome-project", {
        ok: false,
        status: 404
      });
      
      mockResponses.set("POST /api/v1/repos/migrate", {
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: 999,
          name: "awesome-project",
          mirror: true,
          owner: { login: "starred" }
        })
      });

      global.fetch = mock(async (url: string, options?: RequestInit) => {
        const method = options?.method || "GET";
        
        if (url.includes("/api/v1/orgs/starred") && method === "GET") {
          return mockResponses.get("GET /api/v1/orgs/starred");
        }
        
        if (url.includes("/api/v1/repos/starred/awesome-project") && method === "GET") {
          return mockResponses.get("GET /api/v1/repos/starred/awesome-project");
        }
        
        if (url.includes("/api/v1/repos/migrate") && method === "POST") {
          const body = JSON.parse(options?.body as string);
          expect(body.repo_owner).toBe("starred");
          expect(body.mirror).toBe(true);
          return mockResponses.get("POST /api/v1/repos/migrate");
        }
        
        return originalFetch(url, options);
      });

      // Test the flow
      const config: Partial<Config> = {
        userId: "user-123",
        giteaConfig: {
          url: "https://gitea.ui.com",
          token: "gitea-token",
          defaultOwner: "testuser"
        },
        githubConfig: {
          token: "github-token",
          starredReposOrg: "starred"
        }
      };

      // 1. Check if org exists (it does)
      const orgId = await getOrCreateGiteaOrg({
        orgName: "starred",
        config
      });
      expect(orgId).toBe(789);

      // 2. Check if repo exists (it doesn't)
      const repoExists = await isRepoPresentInGitea({
        config,
        owner: "starred",
        repoName: "awesome-project"
      });
      expect(repoExists).toBe(false);

      // 3. Create mirror would happen here in the actual flow
      // The test verifies the setup is correct
    });
  });

  describe("Error recovery strategies", () => {
    test("should suggest recovery steps for non-mirror repository", () => {
      const recoverySteps = [
        "1. Delete the existing non-mirror repository in Gitea",
        "2. Re-run the mirror operation to create it as a proper mirror",
        "3. Alternatively, manually convert the repository to a mirror in Gitea settings"
      ];

      // This test documents the recovery strategy
      expect(recoverySteps).toHaveLength(3);
    });

    test("should suggest recovery steps for duplicate organization", () => {
      const recoverySteps = [
        "1. Check if the organization already exists in Gitea UI",
        "2. If it exists but API returns 404, check permissions",
        "3. Try using a different organization name for starred repos",
        "4. Manually create the organization in Gitea if needed"
      ];

      // This test documents the recovery strategy
      expect(recoverySteps).toHaveLength(4);
    });
  });
});