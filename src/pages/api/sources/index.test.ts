/**
 * Route tests for /api/sources: the list with per-source repository counts
 * and lock state, and the validation, duplicate and write-through rules for
 * adding a source.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

let sourceRows: any[] = [];
let countRows: Array<{ sourceId: string | null; count: number }> = [];

function encrypted(token: string): string {
  return `enc:${token}`;
}

// The service layer syncs the legacy config itself on every write; the mock
// follows its contract (in-memory rows, tokens "encrypted" with a prefix,
// DuplicateSourceError shape) so these tests stay about the route.
mock.module("@/lib/sources", () => ({
  listSources: mock(async (userId: string) =>
    sourceRows.filter((source) => source.userId === userId)
  ),
  createSource: mock(async (userId: string, input: any) => {
    const url = input.url ?? "";
    const username = input.username ?? "";
    const duplicate = sourceRows.find(
      (source) =>
        source.userId === userId &&
        source.provider === input.provider &&
        source.url === url &&
        source.username === username
    );
    if (duplicate) {
      const error = new Error("This source is already connected.");
      (error as any).code = "duplicate_source";
      throw error;
    }
    const row = {
      id: `source-${sourceRows.length + 1}`,
      userId,
      name: input.name || `${input.provider} source`,
      provider: input.provider,
      url,
      username,
      token: input.token ? encrypted(input.token) : null,
      enabled: input.enabled ?? true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sourceRows.push(row);
    return { ...row };
  }),
  updateSource: mock(async (userId: string, sourceId: string, input: any) => {
    const row = sourceRows.find(
      (source) => source.id === sourceId && source.userId === userId
    );
    if (!row) throw new Error("Source not found");
    if (input.provider !== undefined) row.provider = input.provider;
    if (input.url !== undefined) row.url = input.url;
    if (input.name !== undefined) row.name = input.name;
    if (input.username !== undefined) row.username = input.username;
    if (input.enabled !== undefined) row.enabled = input.enabled;
    if (input.token) row.token = encrypted(input.token);
    return { ...row };
  }),
  deleteSource: mock(async (userId: string, sourceId: string) => {
    sourceRows = sourceRows.filter(
      (source) => source.id !== sourceId || source.userId !== userId
    );
  }),
  syncPrimarySourceToConfig: mock(async () => {}),
  decryptSourceToken: mock((token: string | null | undefined) =>
    typeof token === "string" && token.startsWith("enc:") ? token.slice(4) : token ?? ""
  ),
}));

const mockRepositories = {};
mock.module("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          groupBy: async () => countRows,
          limit: async () => [],
        }),
      }),
    }),
    insert: () => ({ values: async () => ({}) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
  },
  repositories: mockRepositories,
  configs: {},
  users: {},
  organizations: {},
  events: {},
  mirrorJobs: {},
  sessions: {},
  accounts: {},
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

const { GET, POST } = await import("./index");

function get() {
  return GET({
    request: new Request("http://localhost/api/sources"),
    locals: { session: { userId: "user-1" } },
  } as any);
}

function post(body: Record<string, unknown>) {
  return POST({
    request: new Request("http://localhost/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  sourceRows = [];
  countRows = [];
});

describe("GET /api/sources", () => {
  test("lists sources with repository counts, lock state and decrypted tokens", async () => {
    sourceRows = [
      {
        id: "source-1",
        userId: "user-1",
        name: "GitHub (octocat)",
        provider: "github",
        url: "",
        username: "octocat",
        token: encrypted("ghp_secret"),
        enabled: true,
      },
      {
        id: "source-2",
        userId: "user-1",
        name: "GitLab",
        provider: "gitlab",
        url: "https://gitlab.example.com",
        username: "octo",
        token: null,
        enabled: false,
      },
    ];
    countRows = [
      { sourceId: "source-1", count: 2 },
      { sourceId: null, count: 5 },
    ];

    const response = await get();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.sources).toHaveLength(2);
    expect(data.sources[0]).toMatchObject({
      id: "source-1",
      name: "GitHub (octocat)",
      provider: "github",
      username: "octocat",
      token: "ghp_secret",
      enabled: true,
      repositoryCount: 2,
      locked: true,
    });
    expect(data.sources[1]).toMatchObject({
      id: "source-2",
      provider: "gitlab",
      token: "",
      enabled: false,
      repositoryCount: 0,
      locked: false,
    });
  });
});

describe("POST /api/sources", () => {
  test("rejects an unknown source provider", async () => {
    const response = await post({ provider: "bitbucket", username: "me", token: "t" });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain("Unknown source provider");
  });

  test("rejects an instance URL that is not http(s) for a GitLab source", async () => {
    const response = await post({
      provider: "gitlab",
      url: "ftp://gitlab.example.com",
      username: "me",
      token: "glpat-x",
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain("GitLab URL");
  });

  test("answers 409 when the same source is already connected", async () => {
    sourceRows = [
      {
        id: "source-1",
        userId: "user-1",
        name: "GitLab",
        provider: "gitlab",
        url: "https://gitlab.example.com",
        username: "me",
        token: null,
        enabled: true,
      },
    ];

    const response = await post({
      provider: "gitlab",
      url: "https://gitlab.example.com",
      username: "me",
      token: "glpat-x",
    });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain("already connected");
    expect(sourceRows).toHaveLength(1);
  });

  test("creates a source, echoes it decrypted", async () => {
    const response = await post({
      name: "Work GitLab",
      provider: "gitlab",
      url: "https://gitlab.example.com",
      username: "me",
      token: "glpat-x",
    });
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.source).toMatchObject({
      name: "Work GitLab",
      provider: "gitlab",
      url: "https://gitlab.example.com",
      username: "me",
      token: "glpat-x",
      repositoryCount: 0,
      locked: false,
    });

    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].token).toBe(encrypted("glpat-x"));
  });
});
