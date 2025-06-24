import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { MirrorRepoRequest } from "@/types/mirror";

// Mock the bun:sqlite module first
mock.module("bun:sqlite", () => {
  return {
    Database: mock(function() {
      return {
        query: mock(() => ({
          all: mock(() => []),
          run: mock(() => ({})),
          get: mock(() => undefined)
        })),
        exec: mock(() => {}),
        prepare: mock(() => ({
          run: mock(() => {}),
          get: mock(() => undefined),
          all: mock(() => [])
        })),
        close: mock(() => {})
      };
    })
  };
});

// Mock the drizzle migrator
mock.module("drizzle-orm/bun-sqlite/migrator", () => {
  return {
    migrate: mock(async () => {
      // Mock successful migration
    })
  };
});

// Mock table symbols with proper structure
const mockConfigs = {
  _: {
    name: "configs",
    schema: undefined,
    columns: {}
  }
};
const mockRepositories = {
  _: {
    name: "repositories",
    schema: undefined,
    columns: {}
  }
};

// Mock the database module
const mockDb = {
  select: mock(() => ({
    from: mock((table: any) => ({
      where: mock((condition: any) => {
        // Return config for configs table
        if (table === mockConfigs) {
          return {
            limit: mock(() => Promise.resolve([{
              id: "config-id",
              userId: "user-id",
              githubConfig: {
                token: "github-token",
                preserveOrgStructure: false,
                mirrorIssues: false
              },
              giteaConfig: {
                url: "https://gitea.example.com",
                token: "gitea-token",
                username: "giteauser"
              }
            }]))
          };
        }
        // Return repositories for repositories table
        return Promise.resolve([
          {
            id: "repo-id-1",
            name: "test-repo-1",
            visibility: "public",
            status: "pending",
            organization: null,
            lastMirrored: null,
            errorMessage: null,
            forkedFrom: null,
            mirroredLocation: ""
          },
          {
            id: "repo-id-2",
            name: "test-repo-2",
            visibility: "public",
            status: "pending",
            organization: null,
            lastMirrored: null,
            errorMessage: null,
            forkedFrom: null,
            mirroredLocation: ""
          }
        ]);
      })
    }))
  }))
};

mock.module("@/lib/db", () => ({
  db: mockDb,
  getDb: async () => mockDb,
  configs: mockConfigs,
  repositories: mockRepositories,
  users: {},
  organizations: {},
  mirrorJobs: {},
  events: {},
  authConfig: {}
}));

// Mock the gitea module
const mockMirrorGithubRepoToGitea = mock(() => Promise.resolve());
const mockMirrorGitHubOrgRepoToGiteaOrg = mock(() => Promise.resolve());

mock.module("@/lib/gitea", () => ({
  mirrorGithubRepoToGitea: mockMirrorGithubRepoToGitea,
  mirrorGitHubOrgRepoToGiteaOrg: mockMirrorGitHubOrgRepoToGiteaOrg,
  getGiteaRepoOwnerAsync: mock(() => Promise.resolve("giteauser"))
}));

// Mock the github module
const mockCreateGitHubClient = mock(() => ({}));

mock.module("@/lib/github", () => ({
  createGitHubClient: mockCreateGitHubClient
}));

// Mock the concurrency module
const mockProcessWithResilience = mock(() => Promise.resolve([]));

mock.module("@/lib/utils/concurrency", () => ({
  processWithResilience: mockProcessWithResilience
}));

// Mock drizzle-orm
mock.module("drizzle-orm", () => ({
  eq: mock(() => ({})),
  inArray: mock(() => ({}))
}));

// Mock the types
mock.module("@/types/Repository", () => ({
  repositoryVisibilityEnum: {
    parse: mock((value: string) => value)
  },
  repoStatusEnum: {
    parse: mock((value: string) => value)
  }
}));

describe("Repository Mirroring API", () => {
  let POST: any;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  
  beforeEach(async () => {
    // Import POST after all mocks are set up
    const module = await import("./mirror-repo");
    POST = module.POST;
    
    // Mock console.log and console.error to prevent test output noise
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
    const request = new Request("http://localhost/api/job/mirror-repo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        repositoryIds: ["repo-id-1", "repo-id-2"]
      })
    });

    const response = await POST({ request } as any);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toBe("userId and repositoryIds are required.");
  });

  test("returns 400 if repositoryIds is missing", async () => {
    const request = new Request("http://localhost/api/job/mirror-repo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "user-id"
      })
    });

    const response = await POST({ request } as any);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toBe("userId and repositoryIds are required.");
  });

  test("returns 200 and starts mirroring repositories", async () => {
    const request = new Request("http://localhost/api/job/mirror-repo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "user-id",
        repositoryIds: ["repo-id-1", "repo-id-2"]
      })
    });

    const response = await POST({ request } as any);

    // Log the response if it's not 200
    if (response.status !== 200) {
      const text = await response.text();
      console.error("Error response text:", text);
    }

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe("Mirror job started.");
    expect(data.repositories).toBeDefined();
  });
});
