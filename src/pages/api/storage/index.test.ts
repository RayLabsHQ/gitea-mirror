/**
 * Route tests for GET /api/storage (#479).
 *
 * NOTE: these tests replace @/lib/db and @/lib/utils/auth-helpers with mocks.
 * bun's mock.module is process-wide and leaks into other test files, so in
 * the shared test process this file registers NOTHING: it re-runs itself in
 * an isolated child process (the same harness as repositories/[id].test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

const CHILD_FLAG = "GM_STORAGE_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("storage route - isolated child suite", () => {
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

let repoRows: any[] = [];
let authResult: { user: { id: string } | null; response: Response | null } = {
  user: { id: "user-1" },
  response: null,
};
/** Leaf values of each select's where() condition (drizzle conditions are cyclic). */
let selectWhereValues: unknown[][] = [];

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
    requireAuth: mock(async () => authResult),
  }));

  mock.module("@/lib/db", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: async (cond: any) => {
            selectWhereValues.push(conditionLeafValues(cond));
            return repoRows;
          },
        }),
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

const { GET } = isChild ? await import("./index") : { GET: undefined as any };

function get() {
  return GET({
    params: {},
    request: new Request("http://localhost/api/storage"),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  selectWhereValues = [];
  authResult = { user: { id: "user-1" }, response: null };
  repoRows = [
    {
      id: "repo-1",
      name: "app",
      fullName: "acme/app",
      mirroredLocation: "archive/app",
      status: "synced",
      destinationProvider: "gitea",
      destinationSize: 4096,
      releaseAssetsSize: 1024,
      releaseAssetsCount: 2,
      storageCheckedAt: new Date("2026-10-29T08:00:00Z"),
    },
  ];
});

describe.skipIf(!isChild)("GET /api/storage", () => {
  test("returns the overview of this user's repositories", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.totals).toMatchObject({ total: 5120, measured: 1, mirrored: 1 });
    expect(data.owners).toEqual([
      { owner: "archive", destinationSize: 4096, releaseAssetsSize: 1024, total: 5120, repositories: 1 },
    ]);
    expect(data.repositories[0]).toMatchObject({
      id: "repo-1",
      location: "archive/app",
      checkedAt: "2026-10-29T08:00:00.000Z",
    });
    expect(selectWhereValues[0]).toEqual(expect.arrayContaining(["user-1"]));
  });

  test("answers the auth helper's response when signed out", async () => {
    authResult = {
      user: null,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    };

    const response = await get();

    expect(response.status).toBe(401);
    expect(selectWhereValues).toEqual([]);
  });
});
