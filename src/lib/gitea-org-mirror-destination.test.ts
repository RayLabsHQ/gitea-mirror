/**
 * Behavioral tests for issue #343 / PR #344:
 * bulk "Mirror Organization" must honor the canonical destination
 * precedence (starred mode > repo override > org override > strategy).
 *
 * NOTE: run standalone (`bun test src/lib/gitea-org-mirror-destination.test.ts`).
 * These tests replace @/lib/db, @/lib/gitea-enhanced, @/lib/http-client,
 * @/lib/helpers, and @/lib/utils/mirror-source-match with module mocks;
 * bun's mock.module is process-wide, so running this file in the full
 * suite could pollute other test files (see the comment in
 * gitea-mirror-failure-recovery.test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Shared mutable state the module mocks read from / write to
// ---------------------------------------------------------------------------

/** Rows returned by the FIRST select on the repositories table (the orgRepos query). */
let orgRepoRows: any[] = [];
/** Row returned for getOrganizationConfig (select from organizations .limit(1)). */
let orgConfigRows: any[] = [];
/** Counts selects against the repositories table. */
let repoSelectCount = 0;
/** Every httpPost call: { url, payload }. */
let httpPostCalls: Array<{ url: string; payload: any }> = [];
/** Every org get-or-create: orgName -> deterministic id. */
let orgCreateCalls: string[] = [];

// Deterministic id derived purely from the name — must not depend on call
// order: bun may re-instantiate mock factories, so an order-dependent counter
// can diverge between the mocked flow and the test's assertions.
function orgIdFor(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 100_000;
  return 100 + h;
}

// ---------------------------------------------------------------------------
// Module mocks (must be registered before importing ./gitea)
// ---------------------------------------------------------------------------

const repositoriesTable = { __table: "repositories" } as any;
const organizationsTable = { __table: "organizations" } as any;

function promiseWithLimit(rows: any[], limitRows?: any[]) {
  const p: any = Promise.resolve(rows);
  p.limit = () => Promise.resolve(limitRows ?? rows);
  return p;
}

mock.module("@/lib/db", () => {
  const mockDb = {
    select: (_fields?: any) => ({
      from: (table: any) => ({
        where: (_cond: any) => {
          if (table === repositoriesTable) {
            repoSelectCount++;
            // First repositories select in mirrorGitHubOrgToGitea is the
            // orgRepos query; everything after (idempotency checks, name
            // claims) must see no rows.
            const rows = repoSelectCount === 1 ? orgRepoRows : [];
            return promiseWithLimit(rows, []);
          }
          if (table === organizationsTable) {
            return promiseWithLimit(orgConfigRows, orgConfigRows);
          }
          return promiseWithLimit([], []);
        },
      }),
    }),
    update: (_table: any) => ({
      set: (_data: any) => ({ where: (_cond: any) => Promise.resolve() }),
    }),
    insert: (_table: any) => ({ values: (_data: any) => Promise.resolve() }),
    delete: (_table: any) => ({ where: (_cond: any) => Promise.resolve() }),
  };
  return {
    db: mockDb,
    repositories: repositoriesTable,
    organizations: organizationsTable,
    configs: {},
    mirrorJobs: {},
    users: {},
    events: {},
    sessions: {},
    accounts: {},
  };
});

mock.module("@/lib/helpers", () => ({
  createMirrorJob: mock(async () => "job-id"),
}));

const actualHttp = await import("./http-client");
const actualEnhanced = await import("./gitea-enhanced");
const actualConfigEncryption = await import("./utils/config-encryption");

mock.module("@/lib/http-client", () => ({
  ...actualHttp,
  httpGet: mock(async (url: string) => {
    throw new actualHttp.HttpError(`GET ${url} -> 404`, 404, "not found");
  }),
  httpPost: mock(async (url: string, payload: any) => {
    httpPostCalls.push({ url, payload });
    return { data: { id: 1, ...payload }, status: 201, statusText: "Created", headers: new Headers() };
  }),
  httpPut: mock(async () => ({ data: {}, status: 200, statusText: "OK", headers: new Headers() })),
  httpPatch: mock(async () => ({ data: {}, status: 200, statusText: "OK", headers: new Headers() })),
  httpDelete: mock(async () => ({ data: {}, status: 204, statusText: "No Content", headers: new Headers() })),
}));

mock.module("@/lib/gitea-enhanced", () => ({
  ...actualEnhanced,
  getOrCreateGiteaOrgEnhanced: mock(async ({ orgName }: any) => {
    orgCreateCalls.push(orgName);
    return orgIdFor(orgName);
  }),
  getGiteaRepoInfo: mock(async () => null),
  handleExistingNonMirrorRepo: mock(async () => {}),
}));

// NOTE: @/lib/utils/mirror-source-match is deliberately NOT mocked. Its real
// implementation resolves to "no existing mirror / name available" naturally
// under the db/fetch/gitea-enhanced mocks above, and module-mocking it
// poisons mirror-source-match.test.ts (bun mock.module is process-wide).

mock.module("@/lib/utils/config-encryption", () => ({
  ...actualConfigEncryption,
  decryptConfigTokens: (config: any) => config,
}));

// isRepoPresentInGitea uses global fetch directly.
globalThis.fetch = mock(async () =>
  new Response("not found", { status: 404 })
) as any;

const { mirrorGitHubOrgToGitea } = await import("./gitea");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: any = {}): any {
  return {
    id: "config-1",
    userId: "user-1",
    githubConfig: {
      token: "gh-token",
      owner: "me",
      ...(overrides.githubConfig || {}),
    },
    giteaConfig: {
      url: "https://gitea.test",
      token: "gitea-token",
      defaultOwner: "meuser",
      addTopics: false,
      ...(overrides.giteaConfig || {}),
    },
  };
}

function makeOrg(overrides: any = {}): any {
  return {
    id: "org-db-1",
    userId: "user-1",
    name: "A",
    membershipRole: "member",
    isIncluded: true,
    status: "imported",
    repositoryCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    destinationOrg: null,
    ...overrides,
  };
}

function makeRepo(overrides: any = {}): any {
  return {
    id: "repo-1",
    userId: "user-1",
    configId: "config-1",
    name: "r1",
    fullName: "A/r1",
    owner: "A",
    organization: "A",
    url: "https://github.com/A/r1",
    cloneUrl: "https://github.com/A/r1.git",
    isPrivate: false,
    isForked: false,
    forkedFrom: null,
    hasIssues: false,
    isStarred: false,
    isArchived: false,
    size: 0,
    hasLFS: false,
    hasSubmodules: false,
    defaultBranch: "main",
    visibility: "public",
    status: "imported",
    destinationOrg: null,
    lastMirrored: null,
    errorMessage: null,
    mirroredLocation: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const fakeOctokit = {} as any;

function migrateCalls() {
  return httpPostCalls.filter((c) => c.url.includes("/repos/migrate"));
}

beforeEach(() => {
  orgRepoRows = [];
  orgConfigRows = [];
  repoSelectCount = 0;
  httpPostCalls = [];
  orgCreateCalls = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mirrorGitHubOrgToGitea destination routing (#343)", () => {

  test("Scenario 1: preserve strategy honors organization destinationOrg override", async () => {
    const config = makeConfig({ githubConfig: { mirrorStrategy: "preserve" } });
    const organization = makeOrg({ destinationOrg: "B" });
    orgRepoRows = [makeRepo()];
    orgConfigRows = [organization];

    await mirrorGitHubOrgToGitea({ organization, octokit: fakeOctokit, config });

    // The override org must be created; the GitHub-named org must NOT be.
    expect(orgCreateCalls).toContain("B");
    expect(orgCreateCalls).not.toContain("A");

    const migrates = migrateCalls();
    expect(migrates.length).toBe(1);
    expect(migrates[0].payload.uid).toBe(orgIdFor("B"));
    expect(migrates[0].payload.repo_name).toBe("r1");
  });

  test("Scenario 2: mixed strategy sends org repos to the GitHub-named org with a defined uid", async () => {
    const config = makeConfig({ githubConfig: { mirrorStrategy: "mixed" } });
    const organization = makeOrg();
    orgRepoRows = [makeRepo()];
    orgConfigRows = [organization];

    await mirrorGitHubOrgToGitea({ organization, octokit: fakeOctokit, config });

    const migrates = migrateCalls();
    expect(migrates.length).toBe(1);
    // The main-branch bug: uid was undefined -> dropped by JSON.stringify ->
    // Gitea defaulted the owner to the authenticated user.
    expect(migrates[0].payload.uid).toBeDefined();
    expect(migrates[0].payload.uid).toBe(orgIdFor("A"));
    expect(orgCreateCalls).toContain("A");
  });

  test("Scenario 3: starred repo in a bulk org mirror follows starred-repo mode", async () => {
    const config = makeConfig({ githubConfig: { mirrorStrategy: "mixed" } });
    const organization = makeOrg();
    orgRepoRows = [
      makeRepo({ id: "repo-2", name: "tools", fullName: "A/tools", isStarred: true }),
    ];
    orgConfigRows = [organization];

    await mirrorGitHubOrgToGitea({ organization, octokit: fakeOctokit, config });

    const migrates = migrateCalls();
    expect(migrates.length).toBe(1);
    expect(orgCreateCalls).toContain("starred");
    expect(migrates[0].payload.uid).toBe(orgIdFor("starred"));
  });

  test("per-repo destinationOrg override beats org override and strategy", async () => {
    const config = makeConfig({ githubConfig: { mirrorStrategy: "preserve" } });
    const organization = makeOrg({ destinationOrg: "B" });
    orgRepoRows = [makeRepo({ destinationOrg: "C" })];
    orgConfigRows = [organization];

    await mirrorGitHubOrgToGitea({ organization, octokit: fakeOctokit, config });

    const migrates = migrateCalls();
    expect(migrates.length).toBe(1);
    expect(migrates[0].payload.uid).toBe(orgIdFor("C"));
    expect(orgCreateCalls).toContain("C");
  });

  test("regression: preserve strategy without overrides keeps GitHub org name and creates the org once", async () => {
    const config = makeConfig({ githubConfig: { mirrorStrategy: "preserve" } });
    const organization = makeOrg();
    orgRepoRows = [
      makeRepo(),
      makeRepo({ id: "repo-3", name: "r2", fullName: "A/r2", cloneUrl: "https://github.com/A/r2.git" }),
    ];
    orgConfigRows = [organization];

    await mirrorGitHubOrgToGitea({ organization, octokit: fakeOctokit, config });

    const migrates = migrateCalls();
    expect(migrates.length).toBe(2);
    for (const call of migrates) {
      expect(call.payload.uid).toBe(orgIdFor("A"));
    }
    // Pre-created once at the top; the per-repo loop must reuse it.
    expect(orgCreateCalls.filter((n) => n === "A").length).toBe(1);
  });

  test("regression: single-org strategy without overrides routes to the configured org", async () => {
    const config = makeConfig({
      githubConfig: { mirrorStrategy: "single-org" },
      giteaConfig: { organization: "hub" },
    });
    const organization = makeOrg();
    orgRepoRows = [makeRepo()];
    orgConfigRows = [organization];

    await mirrorGitHubOrgToGitea({ organization, octokit: fakeOctokit, config });

    const migrates = migrateCalls();
    expect(migrates.length).toBe(1);
    expect(migrates[0].payload.uid).toBe(orgIdFor("hub"));
    expect(orgCreateCalls.filter((n) => n === "hub").length).toBe(1);
  });

  test("regression: flat-user strategy without overrides mirrors to the user account (repo_owner, no org)", async () => {
    const config = makeConfig({ githubConfig: { mirrorStrategy: "flat-user" } });
    const organization = makeOrg();
    orgRepoRows = [makeRepo()];
    orgConfigRows = [organization];

    await mirrorGitHubOrgToGitea({ organization, octokit: fakeOctokit, config });

    const migrates = migrateCalls();
    expect(migrates.length).toBe(1);
    expect(migrates[0].payload.repo_owner).toBe("meuser");
    expect(migrates[0].payload.uid).toBeUndefined();
    expect(orgCreateCalls.length).toBe(0);
  });
});
