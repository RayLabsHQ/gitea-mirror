/**
 * Route tests for the per-organization source pin on PATCH
 * /api/organizations/:id: ownership validation of the pin, clearing it with
 * null, and leaving it untouched when the field is absent. Plus the DELETE
 * repository-deletion scoping for pinned organizations.
 *
 * NOTE: these tests replace @/lib/db, @/lib/sources and
 * @/lib/utils/auth-helpers with mocks. bun's mock.module is process-wide and
 * leaks into other test files, so in the shared test process this file
 * registers NOTHING: it re-runs itself in an isolated child process (the
 * same harness as gitea-org-mirror-destination.test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

const CHILD_FLAG = "GM_ORG_ID_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("organization [id] route (source pin) — isolated child suite", () => {
    const res = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, [CHILD_FLAG]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) {
      console.error(res.stdout.toString());
      console.error(res.stderr.toString());
    }
    expect(res.exitCode).toBe(0);
  }, 60_000);
}

let sourceRows: any[] = [];
let orgRows: any[] = [];
/** Leaf values of each delete's where() condition (drizzle conditions are cyclic). */
let deleteWhereValues: unknown[][] = [];

function conditionLeafValues(node: any, depth = 0): unknown[] {
  if (node == null || depth > 8) return [];
  if (typeof node !== "object") return [node];
  const leaves: unknown[] = [];
  if (Array.isArray(node.value)) leaves.push(...node.value);
  for (const chunk of node.queryChunks ?? []) {
    leaves.push(...conditionLeafValues(chunk, depth + 1));
  }
  return leaves;
}

if (isChild) {
  mock.module("@/lib/utils/auth-helpers", () => ({
    requireAuth: mock(async () => ({ user: { id: "user-1" }, response: null })),
  }));

  mock.module("@/lib/sources", () => ({
    listSources: mock(async (userId: string) =>
      sourceRows.filter((source) => source.userId === userId)
    ),
  }));

  mock.module("@/lib/db", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => orgRows.slice(0, 1),
          }),
        }),
      }),
      update: () => ({
        set: (data: any) => ({
          where: async () => {
            if (orgRows[0]) Object.assign(orgRows[0], data);
          },
        }),
      }),
      delete: () => ({
        where: async (cond: any) => {
          deleteWhereValues.push(conditionLeafValues(cond));
        },
      }),
    },
    organizations: {},
    repositories: {},
    configs: {},
    users: {},
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
    sources: {},
  }));
}

const { PATCH, DELETE } = isChild
  ? await import("./[id]")
  : { PATCH: undefined as any, DELETE: undefined as any };

function patch(body: Record<string, unknown>) {
  return PATCH({
    params: { id: "org-1" },
    request: new Request("http://localhost/api/organizations/org-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: { session: { userId: "user-1" } },
  } as any);
}

function remove() {
  return DELETE({
    params: { id: "org-1" },
    request: new Request("http://localhost/api/organizations/org-1", {
      method: "DELETE",
    }),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  deleteWhereValues = [];
  sourceRows = [
    {
      id: "source-1",
      userId: "user-1",
      name: "GitHub (octocat)",
      provider: "github",
      url: "https://github.com",
      username: "octocat",
      token: null,
      enabled: true,
    },
    {
      id: "source-2",
      userId: "user-2",
      name: "GitLab (someone)",
      provider: "gitlab",
      url: "https://gitlab.com",
      username: "someone",
      token: null,
      enabled: true,
    },
  ];
  orgRows = [
    {
      id: "org-1",
      userId: "user-1",
      name: "acme",
      normalizedName: "acme",
      destinationOrg: null,
      mirrorOverrides: null,
      sourceId: null,
    },
  ];
});

describe.skipIf(!isChild)("PATCH /api/organizations/:id source pin", () => {
  test("pins the organization to a source the user owns", async () => {
    const response = await patch({ sourceId: "source-1" });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.sourceId).toBe("source-1");
    expect(orgRows[0].sourceId).toBe("source-1");
  });

  test("rejects a source that belongs to another user", async () => {
    const response = await patch({ sourceId: "source-2" });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("No source with id source-2");
    expect(orgRows[0].sourceId).toBeNull();
  });

  test("rejects an unknown source id", async () => {
    const response = await patch({ sourceId: "source-missing" });
    expect(response.status).toBe(400);
    expect(orgRows[0].sourceId).toBeNull();
  });

  test("clears the pin with null", async () => {
    orgRows[0].sourceId = "source-1";
    const response = await patch({ sourceId: null });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.sourceId).toBeNull();
    expect(orgRows[0].sourceId).toBeNull();
  });

  test("leaves the pin untouched when the field is absent", async () => {
    orgRows[0].sourceId = "source-1";
    const response = await patch({ destinationOrg: "backup" });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.sourceId).toBe("source-1");
    expect(data.destinationOrg).toBe("backup");
  });

  test("answers 404 for an organization the user does not have", async () => {
    orgRows = [];
    const response = await patch({ sourceId: "source-1" });
    expect(response.status).toBe(404);
  });
});

describe.skipIf(!isChild)("DELETE /api/organizations/:id with a source pin", () => {
  // The route deletes the organization's repositories first, so the first
  // recorded delete is the repositories one.
  function repoDeleteLeaves(): unknown[] {
    return deleteWhereValues[0] ?? [];
  }

  test("a pinned organization deletes only its source's repositories", async () => {
    orgRows[0].sourceId = "source-1";
    const response = await remove();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(repoDeleteLeaves()).toContain("source-1");
    expect(repoDeleteLeaves()).toContain("acme");
  });

  test("an unpinned organization keeps the name-wide repository delete", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(repoDeleteLeaves()).toContain("acme");
    expect(repoDeleteLeaves()).not.toContain("source-1");
  });

  test("a pin whose source was deleted keeps the name-wide repository delete", async () => {
    orgRows[0].sourceId = "source-gone";
    const response = await remove();
    expect(response.status).toBe(200);
    expect(repoDeleteLeaves()).toContain("acme");
    expect(repoDeleteLeaves()).not.toContain("source-gone");
  });
});
