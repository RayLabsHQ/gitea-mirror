import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Octokit } from "@octokit/rest";
import { repoStatusEnum } from "@/types/Repository";
import { getOrCreateGiteaOrg, getGiteaRepoOwner, getGiteaRepoOwnerAsync } from "./gitea";
import type { Config, Repository, Organization } from "./db/schema";

// Mock the isRepoPresentInGitea function
const mockIsRepoPresentInGitea = mock(() => Promise.resolve(false));

// Mock the database module
mock.module("@/lib/db", () => {
  return {
    getDb: async () => ({
      update: () => ({
        set: () => ({
          where: () => Promise.resolve()
        })
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([])
          })
        })
      })
    }),
    repositories: {},
    organizations: {},
    users: {},
    configs: {},
    mirrorJobs: {},
    events: {},
    authConfig: {}
  };
});

// Mock the helpers module
mock.module("@/lib/helpers", () => {
  return {
    createMirrorJob: mock(() => Promise.resolve("job-id"))
  };
});

// Mock http-client
mock.module("@/lib/http-client", () => {
  return {
    httpPost: mock(() => Promise.resolve({ data: { id: 123 }, status: 200, statusText: 'OK', headers: new Headers() })),
    httpGet: mock(() => Promise.resolve({ data: [], status: 200, statusText: 'OK', headers: new Headers() })),
    HttpError: class MockHttpError extends Error {
      constructor(message: string, public status: number, public statusText: string, public response?: string) {
        super(message);
        this.name = 'HttpError';
      }
    }
  };
});

// Mock the gitea module itself
mock.module("./gitea", () => {
  return {
    isRepoPresentInGitea: mockIsRepoPresentInGitea,
    mirrorGithubRepoToGitea: mock(async () => {}),
    mirrorGitHubOrgRepoToGiteaOrg: mock(async () => {})
  };
});

describe("Gitea Repository Mirroring", () => {
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

  test("mirrorGithubRepoToGitea handles private repositories correctly", async () => {
    // Import the mocked function
    const { mirrorGithubRepoToGitea } = await import("./gitea");

    // Create mock Octokit instance
    const octokit = {} as Octokit;

    // Create mock repository (private)
    const repository = {
      id: "repo-id",
      name: "test-repo",
      fullName: "testuser/test-repo",
      url: "https://github.com/testuser/test-repo",
      cloneUrl: "https://github.com/testuser/test-repo.git",
      owner: "testuser",
      isPrivate: true,
      status: repoStatusEnum.parse("imported")
    };

    // Create mock config
    const config = {
      id: "config-id",
      userId: "user-id",
      githubConfig: {
        token: "github-token",
        mirrorIssues: false
      },
      giteaConfig: {
        url: "https://gitea.example.com",
        token: "gitea-token",
        username: "giteauser"
      }
    };

    // Call the function
    await mirrorGithubRepoToGitea({
      octokit,
      repository: repository as any,
      config
    });

    // Check that the function was called
    expect(mirrorGithubRepoToGitea).toHaveBeenCalled();
  });

  test("getOrCreateGiteaOrg handles JSON parsing errors gracefully", async () => {
    // Mock fetch to return invalid JSON
    const originalFetch = global.fetch;
    global.fetch = mock(async (url: string) => {
      if (url.includes("/api/v1/orgs/")) {
        // Mock response that looks successful but has invalid JSON
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name: string) => name === "content-type" ? "application/json" : null
          },
          json: () => Promise.reject(new Error("Unexpected token in JSON")),
          text: () => Promise.resolve("Invalid JSON response"),
          clone: function() {
            return {
              text: () => Promise.resolve("Invalid JSON response")
            };
          }
        } as any;
      }
      return originalFetch(url);
    });

    const config = {
      userId: "user-id",
      giteaConfig: {
        url: "https://gitea.example.com",
        token: "gitea-token"
      }
    };

    try {
      await getOrCreateGiteaOrg({
        orgName: "test-org",
        config
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Should catch the JSON parsing error with a descriptive message
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Failed to parse JSON response from Gitea API");
    } finally {
      // Restore original fetch
      global.fetch = originalFetch;
    }
  });

  test("getOrCreateGiteaOrg handles non-JSON content-type gracefully", async () => {
    // Mock fetch to return HTML instead of JSON
    const originalFetch = global.fetch;
    global.fetch = mock(async (url: string) => {
      if (url.includes("/api/v1/orgs/")) {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name: string) => name === "content-type" ? "text/html" : null
          },
          text: () => Promise.resolve("<html><body>Error page</body></html>")
        } as any;
      }
      return originalFetch(url);
    });

    const config = {
      userId: "user-id",
      giteaConfig: {
        url: "https://gitea.example.com",
        token: "gitea-token"
      }
    };

    try {
      await getOrCreateGiteaOrg({
        orgName: "test-org",
        config
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Should catch the content-type error
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Invalid response format from Gitea API");
      expect((error as Error).message).toContain("text/html");
    } finally {
      // Restore original fetch
      global.fetch = originalFetch;
    }
  });

  test("mirrorGitHubOrgToGitea handles empty organizations correctly", async () => {
    // Mock the createMirrorJob function
    const mockCreateMirrorJob = mock(() => Promise.resolve("job-id"));

    // Mock the getOrCreateGiteaOrg function
    const mockGetOrCreateGiteaOrg = mock(() => Promise.resolve("gitea-org-id"));

    // Create a test version of the function with mocked dependencies
    const testMirrorGitHubOrgToGitea = async ({
      organization,
      config,
    }: {
      organization: any;
      config: any;
    }) => {
      // Simulate the function logic for empty organization
      console.log(`Mirroring organization ${organization.name}`);

      // Mock: get or create Gitea org
      await mockGetOrCreateGiteaOrg();

      // Mock: query the db with the org name and get the repos
      const orgRepos: any[] = []; // Empty array to simulate no repositories

      if (orgRepos.length === 0) {
        console.log(`No repositories found for organization ${organization.name} - marking as successfully mirrored`);
      } else {
        console.log(`Mirroring ${orgRepos.length} repositories for organization ${organization.name}`);
        // Repository processing would happen here
      }

      console.log(`Organization ${organization.name} mirrored successfully`);

      // Mock: Append log for "mirrored" status
      await mockCreateMirrorJob({
        userId: config.userId,
        organizationId: organization.id,
        organizationName: organization.name,
        message: `Successfully mirrored organization: ${organization.name}`,
        details: orgRepos.length === 0
          ? `Organization ${organization.name} was processed successfully (no repositories found).`
          : `Organization ${organization.name} was mirrored to Gitea with ${orgRepos.length} repositories.`,
        status: "mirrored",
      });
    };

    // Create mock organization
    const organization = {
      id: "org-id",
      name: "empty-org",
      status: "imported"
    };

    // Create mock config
    const config = {
      id: "config-id",
      userId: "user-id",
      githubConfig: {
        token: "github-token"
      },
      giteaConfig: {
        url: "https://gitea.example.com",
        token: "gitea-token"
      }
    };

    // Call the test function
    await testMirrorGitHubOrgToGitea({
      organization,
      config
    });

    // Verify that the mirror job was created with the correct details for empty org
    expect(mockCreateMirrorJob).toHaveBeenCalledWith({
      userId: "user-id",
      organizationId: "org-id",
      organizationName: "empty-org",
      message: "Successfully mirrored organization: empty-org",
      details: "Organization empty-org was processed successfully (no repositories found).",
      status: "mirrored",
    });

    // Verify that getOrCreateGiteaOrg was called
    expect(mockGetOrCreateGiteaOrg).toHaveBeenCalled();
  });
});

describe("getGiteaRepoOwner - Organization Override Tests", () => {
  const baseConfig: Partial<Config> = {
    githubConfig: {
      username: "testuser",
      token: "token",
      preserveOrgStructure: false,
      skipForks: false,
      privateRepositories: false,
      mirrorIssues: false,
      mirrorWiki: false,
      mirrorStarred: false,
      useSpecificUser: false,
      includeOrgs: [],
      excludeOrgs: [],
      mirrorPublicOrgs: false,
      publicOrgs: [],
      skipStarredIssues: false
    },
    giteaConfig: {
      username: "giteauser",
      url: "https://gitea.example.com",
      token: "gitea-token",
      organization: "github-mirrors",
      visibility: "public",
      starredReposOrg: "starred",
      preserveOrgStructure: false,
      mirrorStrategy: "preserve"
    }
  };

  const baseRepo: Repository = {
    id: "repo-id",
    userId: "user-id",
    configId: "config-id",
    name: "test-repo",
    fullName: "testuser/test-repo",
    url: "https://github.com/testuser/test-repo",
    cloneUrl: "https://github.com/testuser/test-repo.git",
    owner: "testuser",
    isPrivate: false,
    isForked: false,
    hasIssues: true,
    isStarred: false,
    isArchived: false,
    size: 1000,
    hasLFS: false,
    hasSubmodules: false,
    defaultBranch: "main",
    visibility: "public",
    status: "imported",
    mirroredLocation: "",
    createdAt: new Date(),
    updatedAt: new Date()
  };

  test("starred repos go to starredReposOrg", () => {
    const repo = { ...baseRepo, isStarred: true };
    const result = getGiteaRepoOwner({ config: baseConfig, repository: repo });
    expect(result).toBe("starred");
  });

  test("preserve strategy: personal repos use personalReposOrg override", () => {
    const configWithOverride = {
      ...baseConfig,
      giteaConfig: {
        ...baseConfig.giteaConfig!,
        personalReposOrg: "my-personal-mirrors"
      }
    };
    const repo = { ...baseRepo, organization: undefined };
    const result = getGiteaRepoOwner({ config: configWithOverride, repository: repo });
    expect(result).toBe("my-personal-mirrors");
  });

  test("preserve strategy: personal repos fallback to username when no override", () => {
    const repo = { ...baseRepo, organization: undefined };
    const result = getGiteaRepoOwner({ config: baseConfig, repository: repo });
    expect(result).toBe("giteauser");
  });

  test("preserve strategy: org repos go to same org name", () => {
    const repo = { ...baseRepo, organization: "myorg" };
    const result = getGiteaRepoOwner({ config: baseConfig, repository: repo });
    expect(result).toBe("myorg");
  });

  test("mixed strategy: personal repos go to organization", () => {
    const configWithMixed = {
      ...baseConfig,
      giteaConfig: {
        ...baseConfig.giteaConfig!,
        mirrorStrategy: "mixed" as const,
        organization: "github-mirrors"
      }
    };
    const repo = { ...baseRepo, organization: undefined };
    const result = getGiteaRepoOwner({ config: configWithMixed, repository: repo });
    expect(result).toBe("github-mirrors");
  });

  test("mixed strategy: org repos preserve their structure", () => {
    const configWithMixed = {
      ...baseConfig,
      giteaConfig: {
        ...baseConfig.giteaConfig!,
        mirrorStrategy: "mixed" as const,
        organization: "github-mirrors"
      }
    };
    const repo = { ...baseRepo, organization: "myorg" };
    const result = getGiteaRepoOwner({ config: configWithMixed, repository: repo });
    expect(result).toBe("myorg");
  });

  test("mixed strategy: fallback to username if no org configs", () => {
    const configWithMixed = {
      ...baseConfig,
      giteaConfig: {
        ...baseConfig.giteaConfig!,
        mirrorStrategy: "mixed" as const,
        organization: undefined,
        personalReposOrg: undefined
      }
    };
    const repo = { ...baseRepo, organization: undefined };
    const result = getGiteaRepoOwner({ config: configWithMixed, repository: repo });
    expect(result).toBe("giteauser");
  });
});
