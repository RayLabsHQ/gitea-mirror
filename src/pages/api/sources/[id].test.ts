/**
 * Route tests for /api/sources/:id: the per-source lock that guards host
 * changes on PUT, the confirmation that overrides it, and the removal rules
 * of DELETE (repositories keep their mirrors and their dangling sourceId).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

let sourceRows: any[] = [];
let repositoryCount = 0;

function encrypted(token: string): string {
  return `enc:${token}`;
}

// The service layer syncs the legacy config itself on every write; the mock
// follows its contract (in-memory rows, tokens "encrypted" with a prefix, an
// empty token preserves the stored one) so these tests stay about the route.
mock.module("@/lib/sources", () => ({
  listSources: mock(async (userId: string) =>
    sourceRows.filter((source) => source.userId === userId)
  ),
  createSource: mock(async (userId: string, input: any) => {
    const row = {
      id: `source-${sourceRows.length + 1}`,
      userId,
      name: input.name || `${input.provider} source`,
      provider: input.provider,
      url: input.url ?? "",
      username: input.username ?? "",
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
        where: async () => [{ count: repositoryCount }],
        groupBy: async () => [],
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

const { PUT, DELETE } = await import("./[id]");

const githubSource = {
  id: "source-1",
  userId: "user-1",
  name: "GitHub (octocat)",
  provider: "github",
  url: "",
  username: "octocat",
  token: encrypted("ghp_old"),
  enabled: true,
};

function put(id: string, body: Record<string, unknown>) {
  return PUT({
    params: { id },
    request: new Request(`http://localhost/api/sources/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: { session: { userId: "user-1" } },
  } as any);
}

function remove(id: string, options?: { query?: string; body?: unknown }) {
  return DELETE({
    params: { id },
    request: new Request(
      `http://localhost/api/sources/${id}${options?.query ?? ""}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      }
    ),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  sourceRows = [{ ...githubSource, token: encrypted("ghp_old") }];
  repositoryCount = 2;
});

describe("PUT /api/sources/:id", () => {
  test("answers 404 for a source that is not the account's", async () => {
    const response = await put("source-404", { name: "Renamed" });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain("Source not found");
  });

  test("refuses a host change on a locked source without confirmation", async () => {
    const response = await put("source-1", {
      provider: "gitlab",
      url: "https://gitlab.example.com",
    });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.lock).toBe("source");
    expect(data.message).toContain("2 repositories were imported");
    expect(data.message).toContain("https://github.com");
    expect(data.message).toContain("https://gitlab.example.com");
    expect(data.message).toContain("Confirm the change");
    expect(sourceRows[0].provider).toBe("github");
  });

  test("renaming a locked source needs no confirmation", async () => {
    const response = await put("source-1", { name: "My GitHub" });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.source.name).toBe("My GitHub");
  });

  test("switches the host with confirmSourceChange and preserves an empty token", async () => {
    const response = await put("source-1", {
      provider: "gitlab",
      url: "https://gitlab.example.com",
      token: "",
      confirmSourceChange: true,
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.source).toMatchObject({
      id: "source-1",
      provider: "gitlab",
      url: "https://gitlab.example.com",
      token: "ghp_old",
      repositoryCount: 2,
      locked: true,
    });
  });
});

describe("DELETE /api/sources/:id", () => {
  test("refuses the removal of a source with repositories without confirmation", async () => {
    const response = await remove("source-1");
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.lock).toBe("source");
    expect(data.message).toContain("2 repositories were imported from GitHub (https://github.com)");
    expect(data.message).toContain("Existing mirrors keep syncing");
    expect(sourceRows).toHaveLength(1);
  });

  test("removes the source with repositories once confirmed via query flag", async () => {
    const response = await remove("source-1", { query: "?confirmRemoveSource=true" });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(sourceRows).toHaveLength(0);
  });

  test("removes the source once confirmed via body flag", async () => {
    const response = await remove("source-1", { body: { confirmRemoveSource: true } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(sourceRows).toHaveLength(0);
  });

  test("removes a source without repositories without confirmation", async () => {
    repositoryCount = 0;
    const response = await remove("source-1");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(sourceRows).toHaveLength(0);
  });

  test("answers 404 for a source that is not the account's", async () => {
    const response = await remove("source-404", { query: "?confirmRemoveSource=true" });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain("Source not found");
  });
});
