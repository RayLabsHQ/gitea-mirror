import { describe, test, expect, mock, beforeEach } from "bun:test";
import { repoStatusEnum } from "@/types/Repository";
import {
  clearAllRateLimits,
  markRateLimited,
  rateLimitGateKey,
} from "@/lib/rate-limit-gate";
import type { Repository } from "./db/schema";

// ---------------------------------------------------------------------------
// Isolated behavioral suite for public-only sources (WP4).
//
// The scheduler reads and writes the db through drizzle and talks to every
// enabled source through the source provider; exercising the real module
// needs process-wide module mocks, which (like
// gitea-org-mirror-destination.test.ts) would poison other test files. So
// this file re-runs itself in an isolated child process where the mocks are
// safely contained.
// ---------------------------------------------------------------------------
const CHILD_FLAG = "SCHEDULER_PUBLIC_SOURCE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("public-only scheduled sync — isolated child suite", () => {
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

describe("Scheduler Service - Ignored Repository Handling", () => {
  test("should skip repositories with 'ignored' status", async () => {
    // Create a repository with ignored status
    const ignoredRepo: Partial<Repository> = {
      id: "ignored-repo-id",
      name: "ignored-repo",
      fullName: "user/ignored-repo",
      status: repoStatusEnum.parse("ignored"),
      userId: "user-id",
    };

    // Mock the scheduler logic that checks repository status
    const shouldMirrorRepository = (repo: Partial<Repository>): boolean => {
      // Skip ignored repositories
      if (repo.status === "ignored") {
        return false;
      }
      
      // Skip recently mirrored repositories
      if (repo.status === "synced" || repo.status === "mirrored") {
        const lastUpdated = repo.updatedAt;
        if (lastUpdated && Date.now() - lastUpdated.getTime() < 3600000) {
          return false; // Skip if mirrored within last hour
        }
      }
      
      return true;
    };

    // Test that ignored repository is skipped
    expect(shouldMirrorRepository(ignoredRepo)).toBe(false);
    
    // Test that non-ignored repository is not skipped
    const activeRepo: Partial<Repository> = {
      ...ignoredRepo,
      status: repoStatusEnum.parse("imported"),
    };
    expect(shouldMirrorRepository(activeRepo)).toBe(true);
    
    // Test that recently synced repository is skipped
    const recentlySyncedRepo: Partial<Repository> = {
      ...ignoredRepo,
      status: repoStatusEnum.parse("synced"),
      updatedAt: new Date(),
    };
    expect(shouldMirrorRepository(recentlySyncedRepo)).toBe(false);
    
    // Test that old synced repository is not skipped
    const oldSyncedRepo: Partial<Repository> = {
      ...ignoredRepo,
      status: repoStatusEnum.parse("synced"),
      updatedAt: new Date(Date.now() - 7200000), // 2 hours ago
    };
    expect(shouldMirrorRepository(oldSyncedRepo)).toBe(true);
  });

  test("auto-mirror filter respects autoMirror and autoMirrorStarred independently", () => {
    // Mirrors the inline filter at scheduler-service.ts L228-233 / L609-614:
    // a repo is "starred from another owner" iff isStarred && owner !== githubOwner.
    // Such repos are gated by autoMirrorStarred; everything else is gated by autoMirror.
    const githubOwner = "Alice".toLowerCase();
    const filterRepos = (
      repos: Array<{ name: string; isStarred: boolean; owner: string }>,
      autoMirror: boolean,
      autoMirrorStarred: boolean,
    ) =>
      repos.filter(repo => {
        const isStarredFromOther = repo.isStarred && repo.owner.toLowerCase() !== githubOwner;
        return isStarredFromOther ? autoMirrorStarred : autoMirror;
      });

    // "ALICE" tests case-insensitive owner match — GitHub usernames are case-insensitive,
    // so a self-starred repo stored with different casing must still count as owned.
    const repos = [
      { name: "owned-repo", isStarred: false, owner: "alice" },
      { name: "self-starred", isStarred: true, owner: "ALICE" },
      { name: "starred-from-bob", isStarred: true, owner: "bob" },
    ];

    // Both off: nothing mirrors
    expect(filterRepos(repos, false, false).map(r => r.name)).toEqual([]);

    // Only autoMirror: owned + self-starred, not third-party stars
    expect(filterRepos(repos, true, false).map(r => r.name)).toEqual([
      "owned-repo",
      "self-starred",
    ]);

    // Only autoMirrorStarred: just third-party stars (the bug fix — used to be empty)
    expect(filterRepos(repos, false, true).map(r => r.name)).toEqual([
      "starred-from-bob",
    ]);

    // Both on: everything
    expect(filterRepos(repos, true, true).map(r => r.name)).toEqual([
      "owned-repo",
      "self-starred",
      "starred-from-bob",
    ]);
  });

  test("auto-start gate: enabled=true → should start, enabled=false → should not start even with mirrorInterval", () => {
    // Mirror the gate logic from checkAutoStartConfiguration / performInitialAutoStart.
    // The enabled flag is the single authoritative signal; a configured
    // mirrorInterval is a timing detail and must not bypass a disabled toggle.
    const shouldAutoStart = (scheduleConfig?: { enabled?: boolean }) =>
      scheduleConfig?.enabled === true;

    expect(shouldAutoStart({ enabled: true })).toBe(true);
    expect(shouldAutoStart({ enabled: false })).toBe(false);
    expect(shouldAutoStart({})).toBe(false);
    expect(shouldAutoStart(undefined)).toBe(false);

    // Simulating: user disabled scheduling but has a mirrorInterval configured.
    // The old code checked `scheduleEnabled || hasMirrorInterval`; the fix
    // ensures only the enabled flag is checked.
    const configWithIntervalButDisabled = {
      scheduleConfig: { enabled: false },
      giteaConfig: { mirrorInterval: "8h" },
    };
    expect(shouldAutoStart(configWithIntervalButDisabled.scheduleConfig)).toBe(false);
  });

  test("should validate all repository status enum values", () => {
    const validStatuses = [
      "imported",
      "mirroring",
      "mirrored",
      "syncing",
      "synced",
      "failed",
      "skipped",
      "ignored",
      "deleting",
      "deleted"
    ];

    validStatuses.forEach(status => {
      expect(() => repoStatusEnum.parse(status)).not.toThrow();
    });

    // Test invalid status
    expect(() => repoStatusEnum.parse("invalid-status")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Child-process mocks and behavioral tests (see the banner at the top).
// ---------------------------------------------------------------------------

const repositoriesTable = { __table: "repositories" } as any;
const organizationsTable = { __table: "organizations" } as any;
const configsTable = { __table: "configs" } as any;

let configRows: any[] = [];
let orgRows: any[] = [];
let repoRows: any[] = [];
// Rows the unprojected repository selects return: the auto-mirror and sync
// pools. Empty for the discovery scenarios, filled by the rate limit ones.
let poolRows: any[] = [];
let orgUpdates: Array<Record<string, any>> = [];
let configUpdates: Array<Record<string, any>> = [];
let repoInsertAttempts = 0;

const publicOnlySource = {
  id: "source-public",
  userId: "user-1",
  name: "GitHub (public orgs)",
  provider: "github",
  url: "https://github.com",
  username: "",
  token: "",
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const mockListRepositories = mock(async () => {
  throw new Error("personal discovery must not run for a public-only source");
});
const mockListStarredRepositories = mock(async () => []);
const orgRepoListings = new Map<string, any[]>();
const mockListOrganizationRepositories = mock(async (name: string) =>
  orgRepoListings.get(name) ?? []
);
const mockMirrorRepositoryToDestination = mock(async () => {});
const mockSyncRepositoryOnDestination = mock(async () => {});
const mockCreateSourceProviderFromSource = mock(() => ({
  listRepositories: mockListRepositories,
  listStarredRepositories: mockListStarredRepositories,
  listOrganizationRepositories: mockListOrganizationRepositories,
}));

if (isChild) {
  mock.module("@/lib/db", () => {
    const mockDb = {
      // Projection selects (existing-key lookups, stuck-status recovery)
      // see the in-memory rows; full selects feed the mirror/sync pools,
      // which stay empty in these scenarios.
      select: (fields?: any) => ({
        from: (table: any) => ({
          where: (_cond: any) => {
            if (table === configsTable) return Promise.resolve(configRows);
            if (table === organizationsTable) return Promise.resolve(orgRows);
            if (table === repositoriesTable) {
              return Promise.resolve(fields ? repoRows : poolRows);
            }
            return Promise.resolve([]);
          },
        }),
      }),
      insert: (table: any) => ({
        values: (rows: any) => ({
          // Simulates the uniq (userId, sourceId, normalizedFullName) index
          // behind onConflictDoNothing: conflicting rows are dropped.
          onConflictDoNothing: () => {
            if (table === repositoriesTable) {
              repoInsertAttempts++;
              const keys = new Set(
                repoRows.map((r) => `${r.userId}|${r.sourceId}|${r.normalizedFullName}`)
              );
              for (const row of Array.isArray(rows) ? rows : [rows]) {
                const key = `${row.userId}|${row.sourceId}|${row.normalizedFullName}`;
                if (!keys.has(key)) {
                  repoRows.push(row);
                  keys.add(key);
                }
              }
            }
            return Promise.resolve();
          },
        }),
      }),
      update: (table: any) => ({
        set: (data: any) => ({
          where: (_cond: any) => {
            if (table === organizationsTable) orgUpdates.push(data);
            if (table === configsTable) configUpdates.push(data);
            return Promise.resolve();
          },
        }),
      }),
    };
    return {
      db: mockDb,
      configs: configsTable,
      repositories: repositoriesTable,
      organizations: organizationsTable,
      users: {},
      events: {},
      mirrorJobs: {},
      sessions: {},
      accounts: {},
      ssoProviders: {},
    };
  });

  mock.module("@/lib/sources", () => ({
    listSources: mock(async (userId: string) =>
      publicOnlySource.userId === userId ? [publicOnlySource] : []
    ),
    ensureSourcesFromConfig: mock(async () => {}),
    decryptSourceToken: (token: string | null | undefined) => token ?? "",
    findSourceForRepository: () => null,
    findSourceForOrganization: (
      org: { sourceId?: string | null },
      list: any[]
    ) => (org.sourceId ? list.find((source) => source.id === org.sourceId) ?? null : null),
    resolveGitHubApiBaseUrl: (url: string | null | undefined) => {
      const trimmed = url?.trim().replace(/\/+$/, "") ?? "";
      if (!trimmed || trimmed === "https://github.com") return undefined;
      return `${trimmed}/api/v3`;
    },
  }));

  mock.module("@/lib/source-providers", () => ({
    createSourceProviderFromSource: mockCreateSourceProviderFromSource,
    resolveSourceProviderKind: () => "github",
  }));

  mock.module("@/lib/mirror-dispatch", () => ({
    mirrorRepositoryToDestination: mockMirrorRepositoryToDestination,
    syncRepositoryOnDestination: mockSyncRepositoryOnDestination,
  }));
}

const { schedulerLoop } = isChild
  ? await import("@/lib/scheduler-service")
  : { schedulerLoop: undefined as any };

function makeSchedulerConfig(): any {
  return {
    id: "config-1",
    userId: "user-1",
    isActive: true,
    githubConfig: { token: "" },
    giteaConfig: { url: "https://gitea.test", token: "gitea-token" },
    scheduleConfig: { enabled: true, interval: "1h" },
  };
}

function makeOrgRow(overrides: Record<string, any> = {}): any {
  return {
    id: "org-pinned",
    userId: "user-1",
    configId: "config-1",
    name: "pinned-org",
    normalizedName: "pinned-org",
    avatarUrl: "",
    membershipRole: "member",
    isIncluded: true,
    sourceId: "source-public",
    mirrorOverrides: { skipForks: true },
    status: "imported",
    repositoryCount: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function makeGitRepo(name: string, overrides: Record<string, any> = {}): any {
  return {
    name,
    fullName: `pinned-org/${name}`,
    url: `https://github.com/pinned-org/${name}`,
    cloneUrl: `https://github.com/pinned-org/${name}.git`,
    owner: "pinned-org",
    organization: "pinned-org",
    isPrivate: false,
    isForked: false,
    hasIssues: true,
    isStarred: false,
    isArchived: false,
    size: 0,
    hasLFS: false,
    hasSubmodules: false,
    defaultBranch: "main",
    visibility: "public",
    status: "imported",
    isDisabled: false,
    importedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe.skipIf(!isChild)("Scheduler public-only sources (WP4)", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let consoleLines: string[];

  beforeEach(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    consoleLines = [];
    console.log = mock((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
    }) as any;
    console.error = mock((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
    }) as any;

    configRows = [makeSchedulerConfig()];
    orgRows = [
      makeOrgRow(),
      makeOrgRow({
        id: "org-unpinned",
        name: "unpinned-org",
        normalizedName: "unpinned-org",
        sourceId: null,
        mirrorOverrides: null,
      }),
    ];
    repoRows = [];
    poolRows = [];
    orgUpdates = [];
    configUpdates = [];
    repoInsertAttempts = 0;
    clearAllRateLimits();
    orgRepoListings.clear();
    mockListRepositories.mockClear();
    mockListStarredRepositories.mockClear();
    mockListOrganizationRepositories.mockClear();
    mockCreateSourceProviderFromSource.mockClear();
  });

  test("a destination-only config runs the scheduled sync instead of skipping it", async () => {
    orgRepoListings.set("pinned-org", [makeGitRepo("existing")]);

    await schedulerLoop();

    expect(consoleLines.some((line) => line.includes("[Scheduler] Running scheduled sync for user user-1"))).toBe(true);
    expect(consoleLines.some((line) => line.includes("Skipping sync for user user-1"))).toBe(false);
    expect(mockListOrganizationRepositories).toHaveBeenCalledWith("pinned-org");
  });

  test("personal discovery is skipped for public-only sources while pinned organizations are re-discovered", async () => {
    orgRepoListings.set("pinned-org", [makeGitRepo("existing")]);

    await schedulerLoop();

    expect(mockListRepositories).not.toHaveBeenCalled();
    expect(mockListStarredRepositories).not.toHaveBeenCalled();
    expect(consoleLines.some((line) => line.includes("public-only source: skipping personal discovery"))).toBe(true);
    expect(mockListOrganizationRepositories).toHaveBeenCalledTimes(1);
    expect(mockListOrganizationRepositories).toHaveBeenCalledWith("pinned-org");
    expect(mockListOrganizationRepositories).not.toHaveBeenCalledWith("unpinned-org");
  });

  test("re-discovery imports newly published org repos once and never duplicates them", async () => {
    repoRows.push({
      userId: "user-1",
      sourceId: "source-public",
      name: "existing",
      fullName: "pinned-org/existing",
      normalizedFullName: "pinned-org/existing",
      organization: "pinned-org",
      status: "imported",
    });
    orgRepoListings.set("pinned-org", [
      makeGitRepo("existing"),
      makeGitRepo("newly-published"),
      makeGitRepo("some-fork", { isForked: true }),
    ]);

    await schedulerLoop();

    const orgRepoNames = repoRows
      .filter((row) => row.normalizedFullName?.startsWith("pinned-org/"))
      .map((row) => row.name);
    expect(orgRepoNames).toEqual(["existing", "newly-published"]);
    expect(orgUpdates.some((data) => data.repositoryCount === 3)).toBe(true);

    const attemptsAfterFirstRun = repoInsertAttempts;
    expect(attemptsAfterFirstRun).toBeGreaterThan(0);

    await schedulerLoop();

    const orgRepoNamesAfterSecondRun = repoRows
      .filter((row) => row.normalizedFullName?.startsWith("pinned-org/"))
      .map((row) => row.name);
    expect(orgRepoNamesAfterSecondRun).toEqual(["existing", "newly-published"]);
    // Nothing new on the second run, so discovery does not even attempt an
    // insert: already-tracked repositories are filtered out by identity
    // before the write, not dropped by the unique index afterwards.
    expect(repoInsertAttempts).toBe(attemptsAfterFirstRun);
  });

  test("re-discovery does not add a second row for a repository the user already tracks under another source on the same host", async () => {
    // Imported earlier through a personal token source on github.com, so it
    // has a different sourceId than the pinned public-only source.
    repoRows.push({
      userId: "user-1",
      sourceId: "source-personal",
      name: "shared",
      fullName: "pinned-org/shared",
      normalizedFullName: "pinned-org/shared",
      organization: "pinned-org",
      sourceProvider: "github",
      sourceUrl: "https://github.com",
      status: "mirrored",
    });
    orgRepoListings.set("pinned-org", [makeGitRepo("shared"), makeGitRepo("fresh")]);

    await schedulerLoop();

    const sharedRows = repoRows.filter((row) => row.normalizedFullName === "pinned-org/shared");
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0].sourceId).toBe("source-personal");
    expect(repoRows.some((row) => row.normalizedFullName === "pinned-org/fresh")).toBe(true);
    expect(consoleLines.some((line) => line.includes("already tracked") && line.includes("pinned-org"))).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// Rate limit gate (issue #437).
//
// A scheduled run used to sit inside Octokit until the GitHub limit reset,
// which held the scheduler lock for the whole run: every later tick logged
// "Scheduler is already running, skipping this cycle" and nothing synced until
// the container was restarted. The throttle handler now records the reset on
// the gate and fails the request, and the run below has to notice that and
// stop by itself.
// ---------------------------------------------------------------------------
function makeSyncRow(name: string, overrides: Record<string, any> = {}): any {
  return {
    id: `repo-${name}`,
    userId: "user-1",
    sourceId: "source-public",
    name,
    fullName: `pinned-org/${name}`,
    normalizedFullName: `pinned-org/${name}`,
    owner: "pinned-org",
    organization: "pinned-org",
    sourceProvider: "github",
    sourceUrl: "https://github.com",
    status: "mirrored",
    isStarred: false,
    isForked: false,
    isPrivate: false,
    visibility: "public",
    mirroredLocation: `gitea-org/${name}`,
    lastMirrored: null,
    errorMessage: null,
    forkedFrom: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe.skipIf(!isChild)("Scheduler rate limit gate (#437)", () => {
  let consoleLines: string[];

  beforeEach(() => {
    consoleLines = [];
    const capture = mock((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
    }) as any;
    console.log = capture;
    console.warn = capture;
    console.error = capture;

    configRows = [makeSchedulerConfig()];
    orgRows = [];
    repoRows = [];
    poolRows = [];
    orgUpdates = [];
    configUpdates = [];
    repoInsertAttempts = 0;
    orgRepoListings.clear();
    mockListOrganizationRepositories.mockClear();
    mockMirrorRepositoryToDestination.mockClear();
    mockSyncRepositoryOnDestination.mockClear();
    clearAllRateLimits();
  });

  test("a run that starts rate limited is skipped and comes back just after the reset", async () => {
    const resetAt = new Date(Date.now() + 45 * 60 * 1000);
    markRateLimited(rateLimitGateKey("user-1"), resetAt);
    poolRows = [makeSyncRow("alpha"), makeSyncRow("beta")];

    await schedulerLoop();

    expect(mockSyncRepositoryOnDestination).not.toHaveBeenCalled();
    expect(
      consoleLines.some(
        (line) => line.includes("rate limited until") && line.includes("skipping this run")
      )
    ).toBe(true);

    const nextRun = configUpdates.at(-1)?.scheduleConfig?.nextRun as Date;
    expect(nextRun).toBeInstanceOf(Date);
    expect(nextRun.getTime()).toBe(resetAt.getTime() + 60_000);
  });

  test("a rate limit hit mid-run stops the sync loop and leaves the rest for the next run", async () => {
    const resetAt = new Date(Date.now() + 45 * 60 * 1000);
    orgRows = [makeOrgRow()];
    orgRepoListings.set("pinned-org", [makeGitRepo("existing")]);
    poolRows = [makeSyncRow("alpha"), makeSyncRow("beta"), makeSyncRow("gamma")];

    // Stands in for the throttle handler: discovery runs into the limit and
    // records the reset instead of sleeping through it.
    mockListOrganizationRepositories.mockImplementationOnce(async () => {
      markRateLimited(rateLimitGateKey("user-1"), resetAt);
      throw Object.assign(new Error("API rate limit exceeded for user ID 1."), { status: 403 });
    });

    await schedulerLoop();

    // The run reached the sync phase and then stopped without syncing anything.
    expect(consoleLines.some((line) => line.includes("Syncing 3 repositories for user user-1"))).toBe(true);
    expect(mockSyncRepositoryOnDestination).not.toHaveBeenCalled();
    expect(
      consoleLines.some(
        (line) =>
          line.includes("rate limited until") &&
          line.includes("leaving 3 repositories to sync on the next run")
      )
    ).toBe(true);

    // The lock is released, so the next tick is free to run.
    expect(consoleLines.some((line) => line.includes("already running"))).toBe(false);

    const nextRun = configUpdates.at(-1)?.scheduleConfig?.nextRun as Date;
    expect(nextRun.getTime()).toBe(resetAt.getTime() + 60_000);
  });

  test("the gate only logs once per run", async () => {
    markRateLimited(rateLimitGateKey("user-1"), new Date(Date.now() + 45 * 60 * 1000));
    poolRows = [makeSyncRow("alpha")];

    await schedulerLoop();

    const gateLines = consoleLines.filter((line) => line.includes("rate limited until"));
    expect(gateLines).toHaveLength(1);
  });

  test("a run that is not rate limited syncs every repository as before", async () => {
    poolRows = [makeSyncRow("alpha"), makeSyncRow("beta")];

    await schedulerLoop();

    expect(mockSyncRepositoryOnDestination).toHaveBeenCalledTimes(2);
    expect(consoleLines.some((line) => line.includes("rate limited until"))).toBe(false);
    expect(consoleLines.some((line) => line.includes("Completed scheduled sync for user user-1"))).toBe(true);
  });
});
