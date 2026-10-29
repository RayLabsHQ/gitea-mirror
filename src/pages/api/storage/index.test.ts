/**
 * Route tests for GET /api/storage (#479) and POST /api/storage/refresh.
 *
 * NOTE: these tests replace @/lib/db, @/lib/utils/auth-helpers and
 * @/lib/storage-refresh with mocks.
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
let refreshProgress: unknown = null;
let startResult: unknown = null;
let startedFor: string[] = [];
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

  mock.module("@/lib/storage-refresh", () => ({
    getStorageRefreshProgress: () => refreshProgress,
    startStorageRefresh: async (userId: string) => {
      startedFor.push(userId);
      return startResult;
    },
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
const { POST } = isChild ? await import("./refresh") : { POST: undefined as any };

function get() {
  return GET({
    params: {},
    request: new Request("http://localhost/api/storage"),
    locals: { session: { userId: "user-1" } },
  } as any);
}

function post() {
  return POST({
    params: {},
    request: new Request("http://localhost/api/storage/refresh", { method: "POST" }),
    locals: { session: { userId: "user-1" } },
  } as any);
}

const RUNNING = {
  running: true,
  total: 4,
  done: 1,
  measured: 1,
  missing: 0,
  failed: 0,
  startedAt: "2026-10-29T08:00:00.000Z",
  finishedAt: null,
};

beforeEach(() => {
  refreshProgress = null;
  startResult = { ok: true, progress: RUNNING };
  startedFor = [];
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

describe.skipIf(!isChild)("Refresh sizes progress", () => {
  test("GET reports no run as null and a run's progress as is", async () => {
    expect((await (await get()).json()).refresh).toBeNull();

    refreshProgress = RUNNING;
    expect((await (await get()).json()).refresh).toEqual(RUNNING);
  });
});

describe.skipIf(!isChild)("POST /api/storage/refresh", () => {
  test("starts a run for the signed in user and answers 202 with its progress", async () => {
    const response = await post();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true, refresh: RUNNING });
    expect(startedFor).toEqual(["user-1"]);
  });

  test("passes a refusal through with its status", async () => {
    startResult = { ok: false, status: 400, error: "Configure the destination URL and token first" };

    const response = await post();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Configure the destination URL and token first",
    });
  });

  test("answers the auth helper's response when signed out", async () => {
    authResult = {
      user: null,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    };

    const response = await post();

    expect(response.status).toBe(401);
    expect(startedFor).toEqual([]);
  });
});
