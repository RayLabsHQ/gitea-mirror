import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { MirrorRepoRequest } from "@/types/mirror";
import { POST } from "./mirror-repo";

// Mock the database module
const mockDb = {
  select: mock(() => ({
    from: mock((table: any) => ({
      where: mock(() => {
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

const mockConfigs = {};
const mockRepositories = {};

mock.module("@/lib/db", () => ({
  db: mockDb,
  configs: mockConfigs,
  repositories: mockRepositories,
  users: {},
  organizations: {},
  mirrorJobs: {},
  events: {},
  accounts: {},
  sessions: {}
}));

// Mock the gitea module
const mockMirrorGithubRepoToGitea = mock(() => Promise.resolve());
const mockMirrorGitHubOrgRepoToGiteaOrg = mock(() => Promise.resolve());

mock.module("@/lib/gitea", () => ({
  mirrorGithubRepoToGitea: mockMirrorGithubRepoToGitea,
  mirrorGitHubOrgRepoToGiteaOrg: mockMirrorGitHubOrgRepoToGiteaOrg,
  getGiteaRepoOwnerAsync: mock(() => Promise.resolve("test-owner")),
  isRepoPresentInGitea: mock(() => Promise.resolve(true)),
  syncGiteaRepo: mock(() => Promise.resolve({ success: true })),
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
  and: mock(() => ({})),
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

  test("returns 401 when request is unauthenticated", async () => {
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

    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Unauthorized");
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

    const response = await POST({
      request,
      locals: {
        session: { userId: "user-id" },
      },
    } as any);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toBe("repositoryIds are required.");
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

    const response = await POST({
      request,
      locals: {
        session: { userId: "user-id" },
      },
    } as any);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe("Mirror job started.");
    expect(data.repositories).toBeDefined();
  });
});
