/**
 * Route tests for GET /api/repositories/preview-repositories.
 *
 * The global tag-rule preview offers these repositories in a picker, so what
 * matters is that the list is scoped to the caller and shaped with a display
 * label.
 *
 * NOTE: this file replaces @/lib/db with a mock. bun's mock.module is
 * process-wide and leaks into other test files, so in the shared test process
 * this file registers NOTHING: it re-runs itself in an isolated child process
 * (the same harness as organizations/[id].test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

const CHILD_FLAG = "GM_GLOBAL_PREVIEW_REPOS_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

let repoRows: any[] = [];
const mockRepositories = {};

if (!isChild) {
  test("global preview-repositories route - isolated child suite", () => {
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

if (isChild) {
  const mockDb = {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          orderBy: mock(() => ({
            limit: mock(() => Promise.resolve(repoRows)),
          })),
        })),
      })),
    })),
  };

  // The route pulls in the auth module, which imports every table, so the mock
  // has to name them all.
  mock.module("@/lib/db", () => ({
    db: mockDb,
    repositories: mockRepositories,
    configs: {},
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
}

const { GET } = isChild
  ? await import("./preview-repositories")
  : { GET: undefined as any };

function call() {
  return GET({
    params: {},
    request: new Request("http://localhost/api/repositories/preview-repositories"),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  repoRows = [
    { id: "r1", name: "hello", owner: "octocat" },
    { id: "r2", name: "world", owner: "octo-org" },
  ];
});

describe.skipIf(!isChild)("GET /api/repositories/preview-repositories", () => {
  test("lists the account's repositories with a display label", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.repositories).toEqual([
      { id: "r1", label: "octocat/hello" },
      { id: "r2", label: "octo-org/world" },
    ]);
    expect(data.truncated).toBe(false);
  });

  test("returns an empty list when nothing is mirrored yet", async () => {
    repoRows = [];
    const response = await call();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.repositories).toEqual([]);
  });
});
