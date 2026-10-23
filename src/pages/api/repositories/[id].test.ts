/**
 * Route tests for GET /api/repositories/:id: the single-repository lookup
 * integrations poll after starting a mirror.
 *
 * NOTE: these tests replace @/lib/db and @/lib/utils/auth-helpers with mocks.
 * bun's mock.module is process-wide and leaks into other test files, so in
 * the shared test process this file registers NOTHING: it re-runs itself in
 * an isolated child process (the same harness as organizations/[id].test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

const CHILD_FLAG = "GM_REPO_ID_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("repository [id] route — isolated child suite", () => {
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
    requireAuth: mock(async () => ({ user: { id: "user-1" }, response: null })),
  }));

  mock.module("@/lib/db", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: (cond: any) => {
            selectWhereValues.push(conditionLeafValues(cond));
            return { limit: async () => repoRows.slice(0, 1) };
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

const { GET } = isChild ? await import("./[id]") : { GET: undefined as any };

function get() {
  return GET({
    params: { id: "repo-1" },
    request: new Request("http://localhost/api/repositories/repo-1"),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  selectWhereValues = [];
  repoRows = [
    {
      id: "repo-1",
      userId: "user-1",
      name: "hello-world",
      fullName: "octocat/hello-world",
      organization: null,
      status: "mirroring",
      visibility: "public",
      lastMirrored: null,
      errorMessage: null,
      forkedFrom: null,
    },
  ];
});

describe.skipIf(!isChild)("GET /api/repositories/:id", () => {
  test("returns the repository, looked up by id and owner", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.repository).toMatchObject({
      id: "repo-1",
      fullName: "octocat/hello-world",
      status: "mirroring",
    });
    // Same shape as the list endpoint: nulls become absent fields.
    expect(data.repository).not.toHaveProperty("lastMirrored");
    expect(data.repository).not.toHaveProperty("organization");
    expect(selectWhereValues[0]).toEqual(expect.arrayContaining(["repo-1", "user-1"]));
  });

  test("404s when the repository is not this user's", async () => {
    repoRows = [];

    const response = await get();

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Repository not found");
  });
});
