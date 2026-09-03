/**
 * Route tests for POST /api/repositories/:id/move-mirror (issue #400): input
 * checks, ownership, the owner the service is asked to move to, and what is
 * written once the service answers.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

let repoRows: any[] = [];
let configRows: any[] = [];
const dbUpdateSetCalls: any[] = [];
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
  update: mock(() => ({
    set: mock((data: any) => {
      dbUpdateSetCalls.push(data);
      return { where: mock(() => Promise.resolve()) };
    }),
  })),
};

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

// Bun keeps module mocks across test files, and an earlier route test mocks
// this module with another owner; mocking it here keeps the answer fixed
// whatever the order.
mock.module("@/lib/gitea", () => ({
  getGiteaRepoOwnerAsync: mock(async () => "me"),
  getGiteaRepoOwner: mock(() => "me"),
  mirrorGithubRepoToGitea: mock(async () => {}),
  mirrorGitHubOrgRepoToGiteaOrg: mock(async () => {}),
  isRepoPresentInGitea: mock(async () => true),
  syncGiteaRepo: mock(async () => ({ success: true })),
}));

const mockMoveMirror = mock(async () => ({
  outcome: "moved",
  from: "mirrors/hello",
  to: "archive/hello",
  message: "Moved octocat/hello from mirrors/hello to archive/hello.",
}));
mock.module("@/lib/destination-transfer-service", () => ({
  moveMirror: mockMoveMirror,
  moveOrganizationMirrors: mock(async () => ({})),
  ensureDestinationOwner: mock(async () => {}),
}));

const { POST } = await import("./move-mirror");
const { MoveMirrorError } = await import("@/lib/destination-transfer");

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
  cloneUrl: "https://github.com/octocat/hello.git",
  url: "https://github.com/octocat/hello",
  destinationProvider: "gitea",
  destinationUrl: "https://gitea.example.com",
};

const configRow = {
  id: "c1",
  userId: "user-1",
  isActive: true,
  githubConfig: { token: "gh", owner: "octocat", mirrorStrategy: "preserve" },
  giteaConfig: { url: "https://gitea.example.com", token: "t", defaultOwner: "me", provider: "gitea" },
};

function call(body: unknown, id = "r1") {
  return POST({
    params: { id },
    request: new Request(`http://localhost/api/repositories/${id}/move-mirror`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  repoRows = [repoRow];
  configRows = [configRow];
  dbUpdateSetCalls.length = 0;
  mockMoveMirror.mockClear();
});

describe("POST /api/repositories/:id/move-mirror", () => {
  test("rejects an owner name that could change the destination URL", async () => {
    const response = await call({ destinationOrg: "arch/ive" });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("letters");
    expect(mockMoveMirror).not.toHaveBeenCalled();
  });

  test("answers 404 for a repository that is not the account's", async () => {
    repoRows = [];
    const response = await call({ destinationOrg: "archive" });
    expect(response.status).toBe(404);
    expect(mockMoveMirror).not.toHaveBeenCalled();
  });

  test("refuses before the destination is configured", async () => {
    configRows = [{ ...configRow, giteaConfig: { url: "", token: "", defaultOwner: "" } }];
    const response = await call({ destinationOrg: "archive" });
    expect(response.status).toBe(400);
    expect(mockMoveMirror).not.toHaveBeenCalled();
  });

  test("moves the mirror, then writes the override", async () => {
    const response = await call({ destinationOrg: "archive" });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.transfer.outcome).toBe("moved");
    expect(data.transfer.to).toBe("archive/hello");

    expect(mockMoveMirror).toHaveBeenCalledTimes(1);
    const args = (mockMoveMirror.mock.calls[0] as any[])[0];
    expect(args.newOwner).toBe("archive");
    expect(args.repository.id).toBe("r1");
    expect(dbUpdateSetCalls).toEqual([expect.objectContaining({ destinationOrg: "archive" })]);
  });

  test("a null destination moves the mirror back to where the strategy puts it", async () => {
    const response = await call({ destinationOrg: null });
    expect(response.status).toBe(200);

    const args = (mockMoveMirror.mock.calls[0] as any[])[0];
    // The owner the strategy resolves for the row without its override.
    expect(args.newOwner).toBe("me");
    expect(args.repository.destinationOrg).toBeNull();
    expect(dbUpdateSetCalls).toEqual([expect.objectContaining({ destinationOrg: null })]);
  });

  test("a refused move changes nothing and carries the reason", async () => {
    mockMoveMirror.mockImplementationOnce(async () => {
      throw new MoveMirrorError("archive/hello already exists", 409, "name-taken");
    });
    const response = await call({ destinationOrg: "archive" });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.code).toBe("name-taken");
    expect(data.error).toContain("already exists");
    expect(dbUpdateSetCalls).toHaveLength(0);
  });
});
