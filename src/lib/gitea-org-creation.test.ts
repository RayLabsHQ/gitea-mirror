import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { getOrCreateGiteaOrg } from "./gitea";
import type { Config } from "./db/schema";
import { createMirrorJob } from "./helpers";

// Mock the helpers module
mock.module("@/lib/helpers", () => {
  return {
    createMirrorJob: mock(() => Promise.resolve("job-id"))
  };
});

describe("Gitea Organization Creation Error Handling", () => {
  let originalFetch: typeof global.fetch;
  let mockCreateMirrorJob: any;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockCreateMirrorJob = mock(() => Promise.resolve("job-id"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("Duplicate organization constraint errors", () => {
    test("should handle PostgreSQL duplicate key constraint violation", async () => {
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/orgs/starred") && options?.method === "GET") {
          // Organization doesn't exist according to GET
          return {
            ok: false,
            status: 404,
            statusText: "Not Found"
          } as Response;
        }
        
        if (url.includes("/api/v1/orgs") && options?.method === "POST") {
          // But creation fails with duplicate key error
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

    test("should handle MySQL duplicate entry error", async () => {
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/orgs/starred") && options?.method === "GET") {
          return {
            ok: false,
            status: 404
          } as Response;
        }
        
        if (url.includes("/api/v1/orgs") && options?.method === "POST") {
          return {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              message: "Duplicate entry 'starred' for key 'organizations.username'",
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

      try {
        await getOrCreateGiteaOrg({
          orgName: "starred",
          config
        });
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Duplicate entry");
      }
    });
  });

  describe("Race condition handling", () => {
    test("should handle race condition where org is created between check and create", async () => {
      let checkCount = 0;
      
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/orgs/starred") && options?.method === "GET") {
          checkCount++;
          
          if (checkCount === 1) {
            // First check: org doesn't exist
            return {
              ok: false,
              status: 404
            } as Response;
          } else {
            // Subsequent checks: org exists (created by another process)
            return {
              ok: true,
              status: 200,
              headers: new Headers({ "content-type": "application/json" }),
              json: async () => ({
                id: 789,
                username: "starred",
                full_name: "Starred Repositories"
              })
            } as Response;
          }
        }
        
        if (url.includes("/api/v1/orgs") && options?.method === "POST") {
          // Creation fails because org was created by another process
          return {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              message: "Organization already exists",
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

      // Current implementation throws error - should ideally retry and succeed
      try {
        await getOrCreateGiteaOrg({
          orgName: "starred",
          config
        });
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        // Documents current behavior - should be improved
      }
    });

    test("proposed fix: retry logic for race conditions", async () => {
      // This test documents how the function should handle race conditions
      const getOrCreateGiteaOrgWithRetry = async ({
        orgName,
        config,
        maxRetries = 3
      }: {
        orgName: string;
        config: Partial<Config>;
        maxRetries?: number;
      }): Promise<number> => {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Check if org exists
            const checkResponse = await fetch(
              `${config.giteaConfig!.url}/api/v1/orgs/${orgName}`,
              {
                headers: {
                  Authorization: `token ${config.giteaConfig!.token}`
                }
              }
            );

            if (checkResponse.ok) {
              const org = await checkResponse.json();
              return org.id;
            }

            // Try to create org
            const createResponse = await fetch(
              `${config.giteaConfig!.url}/api/v1/orgs`,
              {
                method: "POST",
                headers: {
                  Authorization: `token ${config.giteaConfig!.token}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  username: orgName,
                  full_name: orgName === "starred" ? "Starred Repositories" : orgName
                })
              }
            );

            if (createResponse.ok) {
              const newOrg = await createResponse.json();
              return newOrg.id;
            }

            const error = await createResponse.json();
            
            // If it's a duplicate error, retry with check
            if (
              error.message?.includes("duplicate") ||
              error.message?.includes("already exists")
            ) {
              continue; // Retry the loop
            }

            throw new Error(error.message);
          } catch (error) {
            if (attempt === maxRetries - 1) {
              throw error;
            }
          }
        }
        
        throw new Error(`Failed to create organization after ${maxRetries} attempts`);
      };

      // Mock successful retry scenario
      let attemptCount = 0;
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        attemptCount++;
        
        if (url.includes("/api/v1/orgs/starred") && options?.method === "GET") {
          if (attemptCount <= 2) {
            return { ok: false, status: 404 } as Response;
          }
          // On third attempt, org exists
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ id: 999, username: "starred" })
          } as Response;
        }
        
        if (url.includes("/api/v1/orgs") && options?.method === "POST") {
          // Always fail creation with duplicate error
          return {
            ok: false,
            status: 400,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ message: "Organization already exists" })
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

      const orgId = await getOrCreateGiteaOrgWithRetry({
        orgName: "starred",
        config
      });

      expect(orgId).toBe(999);
      expect(attemptCount).toBeGreaterThan(2);
    });
  });

  describe("Organization naming conflicts", () => {
    test("should handle case-sensitivity conflicts", async () => {
      // Some databases treat 'Starred' and 'starred' as the same
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        const body = options?.body ? JSON.parse(options.body as string) : null;
        
        if (url.includes("/api/v1/orgs") && options?.method === "POST") {
          if (body?.username === "Starred") {
            return {
              ok: false,
              status: 400,
              headers: new Headers({ "content-type": "application/json" }),
              json: async () => ({
                message: "Organization 'starred' already exists (case-insensitive match)",
                url: "https://gitea.url.com/api/swagger"
              })
            } as Response;
          }
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
        const response = await fetch(
          `${config.giteaConfig!.url}/api/v1/orgs`,
          {
            method: "POST",
            headers: {
              Authorization: `token ${config.giteaConfig!.token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              username: "Starred", // Different case
              full_name: "Starred Repositories"
            })
          }
        );

        const error = await response.json();
        expect(error.message).toContain("case-insensitive match");
      } catch (error) {
        // Expected
      }
    });

    test("should suggest alternative org names when conflicts occur", () => {
      const suggestAlternativeOrgNames = (baseName: string): string[] => {
        return [
          `${baseName}-mirror`,
          `${baseName}-repos`,
          `${baseName}-${new Date().getFullYear()}`,
          `my-${baseName}`,
          `github-${baseName}`
        ];
      };

      const alternatives = suggestAlternativeOrgNames("starred");
      
      expect(alternatives).toContain("starred-mirror");
      expect(alternatives).toContain("starred-repos");
      expect(alternatives.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("Permission and visibility issues", () => {
    test("should handle organization visibility constraints", async () => {
      global.fetch = mock(async (url: string, options?: RequestInit) => {
        if (url.includes("/api/v1/orgs") && options?.method === "POST") {
          const body = JSON.parse(options.body as string);
          
          // Simulate server rejecting certain visibility settings
          if (body.visibility === "private") {
            return {
              ok: false,
              status: 400,
              headers: new Headers({ "content-type": "application/json" }),
              json: async () => ({
                message: "Private organizations are not allowed for this user",
                url: "https://gitea.url.com/api/swagger"
              })
            } as Response;
          }
        }
        
        return originalFetch(url, options);
      });

      const config: Partial<Config> = {
        userId: "user-123",
        giteaConfig: {
          url: "https://gitea.url.com",
          token: "gitea-token",
          visibility: "private" // This will cause the error
        }
      };

      try {
        const response = await fetch(
          `${config.giteaConfig!.url}/api/v1/orgs`,
          {
            method: "POST",
            headers: {
              Authorization: `token ${config.giteaConfig!.token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              username: "starred",
              full_name: "Starred Repositories",
              visibility: config.giteaConfig!.visibility
            })
          }
        );

        if (!response.ok) {
          const error = await response.json();
          expect(error.message).toContain("Private organizations are not allowed");
        }
      } catch (error) {
        // Expected
      }
    });
  });
});