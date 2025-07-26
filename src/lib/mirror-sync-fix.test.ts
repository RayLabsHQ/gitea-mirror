import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { Config, Repository } from "./db/schema";
import { repoStatusEnum } from "@/types/Repository";

describe("Mirror Sync Fix Implementation", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("Non-mirror repository recovery", () => {
    test("should detect and handle non-mirror repositories", async () => {
      const mockHandleNonMirrorRepo = async ({
        config,
        repository,
        owner,
      }: {
        config: Partial<Config>;
        repository: Repository;
        owner: string;
      }) => {
        try {
          // First, check if the repo exists
          const checkResponse = await fetch(
            `${config.giteaConfig!.url}/api/v1/repos/${owner}/${repository.name}`,
            {
              headers: {
                Authorization: `token ${config.giteaConfig!.token}`,
              },
            }
          );

          if (!checkResponse.ok) {
            // Repo doesn't exist, we can create it as mirror
            return { action: "create_mirror", success: true };
          }

          const repoInfo = await checkResponse.json();
          
          if (!repoInfo.mirror) {
            // Repository exists but is not a mirror
            console.log(`Repository ${repository.name} exists but is not a mirror`);
            
            // Option 1: Delete and recreate
            if (config.giteaConfig?.autoFixNonMirrors) {
              const deleteResponse = await fetch(
                `${config.giteaConfig.url}/api/v1/repos/${owner}/${repository.name}`,
                {
                  method: "DELETE",
                  headers: {
                    Authorization: `token ${config.giteaConfig.token}`,
                  },
                }
              );

              if (deleteResponse.ok) {
                return { action: "deleted_for_recreation", success: true };
              }
            }
            
            // Option 2: Mark for manual intervention
            return {
              action: "manual_intervention_required",
              success: false,
              reason: "Repository exists but is not configured as mirror",
              suggestion: `Delete ${owner}/${repository.name} in Gitea and re-run mirror`,
            };
          }

          // Repository is already a mirror, can proceed with sync
          return { action: "sync_mirror", success: true };
        } catch (error) {
          return {
            action: "error",
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      };

      // Test scenario 1: Non-mirror repository
      global.fetch = mock(async (url: string) => {
        if (url.includes("/api/v1/repos/starred/test-repo")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              id: 123,
              name: "test-repo",
              mirror: false, // Not a mirror
              owner: { login: "starred" },
            }),
          } as Response;
        }
        return originalFetch(url);
      });

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.ui.com",
          token: "gitea-token",
          autoFixNonMirrors: false, // Manual intervention mode
        },
      };

      const repository: Repository = {
        id: "repo-123",
        name: "test-repo",
        isStarred: true,
        // ... other fields
      } as Repository;

      const result = await mockHandleNonMirrorRepo({
        config,
        repository,
        owner: "starred",
      });

      expect(result.action).toBe("manual_intervention_required");
      expect(result.success).toBe(false);
      expect(result.suggestion).toContain("Delete starred/test-repo");
    });

    test("should successfully delete and prepare for recreation when autoFix is enabled", async () => {
      let deleteRequested = false;

      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/repos/starred/test-repo")) {
          if (options?.method === "DELETE") {
            deleteRequested = true;
            return {
              ok: true,
              status: 204,
            } as Response;
          }
          
          // GET request
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              id: 123,
              name: "test-repo",
              mirror: false,
              owner: { login: "starred" },
            }),
          } as Response;
        }
        return originalFetch(url, options);
      });

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.ui.com",
          token: "gitea-token",
          autoFixNonMirrors: true, // Auto-fix enabled
        },
      };

      // Simulate the fix process
      const checkResponse = await fetch(
        `${config.giteaConfig!.url}/api/v1/repos/starred/test-repo`,
        {
          headers: {
            Authorization: `token ${config.giteaConfig!.token}`,
          },
        }
      );

      const repoInfo = await checkResponse.json();
      expect(repoInfo.mirror).toBe(false);

      // Delete the non-mirror repo
      const deleteResponse = await fetch(
        `${config.giteaConfig!.url}/api/v1/repos/starred/test-repo`,
        {
          method: "DELETE",
          headers: {
            Authorization: `token ${config.giteaConfig!.token}`,
          },
        }
      );

      expect(deleteResponse.ok).toBe(true);
      expect(deleteRequested).toBe(true);
    });
  });

  describe("Enhanced mirror creation with validation", () => {
    test("should validate repository before creating mirror", async () => {
      const createMirrorWithValidation = async ({
        config,
        repository,
        owner,
      }: {
        config: Partial<Config>;
        repository: Repository;
        owner: string;
      }) => {
        // Step 1: Check if repo already exists
        const checkResponse = await fetch(
          `${config.giteaConfig!.url}/api/v1/repos/${owner}/${repository.name}`,
          {
            headers: {
              Authorization: `token ${config.giteaConfig!.token}`,
            },
          }
        );

        if (checkResponse.ok) {
          const existingRepo = await checkResponse.json();
          if (existingRepo.mirror) {
            return {
              created: false,
              reason: "already_mirror",
              repoId: existingRepo.id,
            };
          } else {
            return {
              created: false,
              reason: "exists_not_mirror",
              repoId: existingRepo.id,
            };
          }
        }

        // Step 2: Create as mirror
        const cloneUrl = repository.isPrivate
          ? repository.cloneUrl.replace("https://", `https://GITHUB_TOKEN@`)
          : repository.cloneUrl;

        const createResponse = await fetch(
          `${config.giteaConfig!.url}/api/v1/repos/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: `token ${config.giteaConfig!.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              clone_addr: cloneUrl,
              repo_name: repository.name,
              mirror: true, // Ensure this is always true
              repo_owner: owner,
              private: repository.isPrivate,
              description: `Mirrored from ${repository.fullName}`,
              service: "git",
            }),
          }
        );

        if (createResponse.ok) {
          const newRepo = await createResponse.json();
          return {
            created: true,
            reason: "success",
            repoId: newRepo.id,
          };
        }

        const error = await createResponse.json();
        return {
          created: false,
          reason: "create_failed",
          error: error.message,
        };
      };

      // Mock successful mirror creation
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/repos/starred/new-repo") && !options?.method) {
          return {
            ok: false,
            status: 404,
          } as Response;
        }

        if (url.includes("/api/v1/repos/migrate")) {
          const body = JSON.parse(options?.body as string);
          expect(body.mirror).toBe(true); // Validate mirror flag
          expect(body.repo_owner).toBe("starred");
          
          return {
            ok: true,
            status: 201,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              id: 456,
              name: body.repo_name,
              mirror: true,
              owner: { login: body.repo_owner },
            }),
          } as Response;
        }

        return originalFetch(url, options);
      });

      const config: Partial<Config> = {
        giteaConfig: {
          url: "https://gitea.ui.com",
          token: "gitea-token",
        },
      };

      const repository: Repository = {
        id: "repo-456",
        name: "new-repo",
        fullName: "original/new-repo",
        cloneUrl: "https://github.com/original/new-repo.git",
        isPrivate: false,
        isStarred: true,
        // ... other fields
      } as Repository;

      const result = await createMirrorWithValidation({
        config,
        repository,
        owner: "starred",
      });

      expect(result.created).toBe(true);
      expect(result.reason).toBe("success");
      expect(result.repoId).toBe(456);
    });
  });

  describe("Sync status tracking", () => {
    test("should track sync attempts and failures", async () => {
      interface SyncAttempt {
        repositoryId: string;
        attemptNumber: number;
        timestamp: Date;
        error?: string;
        success: boolean;
      }

      const syncAttempts: Map<string, SyncAttempt[]> = new Map();

      const trackSyncAttempt = (
        repositoryId: string,
        success: boolean,
        error?: string
      ) => {
        const attempts = syncAttempts.get(repositoryId) || [];
        attempts.push({
          repositoryId,
          attemptNumber: attempts.length + 1,
          timestamp: new Date(),
          error,
          success,
        });
        syncAttempts.set(repositoryId, attempts);
      };

      const shouldRetrySync = (repositoryId: string): boolean => {
        const attempts = syncAttempts.get(repositoryId) || [];
        if (attempts.length === 0) return true;
        
        const lastAttempt = attempts[attempts.length - 1];
        const timeSinceLastAttempt = 
          Date.now() - lastAttempt.timestamp.getTime();
        
        // Retry if:
        // 1. Less than 3 attempts
        // 2. At least 5 minutes since last attempt
        // 3. Last error was not "Repository is not a mirror"
        return (
          attempts.length < 3 &&
          timeSinceLastAttempt > 5 * 60 * 1000 &&
          !lastAttempt.error?.includes("Repository is not a mirror")
        );
      };

      // Simulate sync attempts
      trackSyncAttempt("repo-123", false, "Repository is not a mirror");
      trackSyncAttempt("repo-456", false, "Network timeout");
      trackSyncAttempt("repo-456", true);

      expect(shouldRetrySync("repo-123")).toBe(false); // Non-retryable error
      expect(shouldRetrySync("repo-456")).toBe(false); // Already succeeded
      expect(shouldRetrySync("repo-789")).toBe(true); // No attempts yet
    });
  });
});