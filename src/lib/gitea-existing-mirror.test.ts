/**
 * What the mirror paths do when the mirror is already on the destination (#496).
 *
 * A reverse proxy can time out on the migrate call while Gitea carries on. The
 * retry then finds the repository in place, and used to record that it exists and
 * stop, so the row went green without the releases, issues or anything else a
 * first mirror brings. It now hands over to a full sync, after waiting for an
 * import Gitea is still running.
 *
 * bun's mock.module is process wide, so the mocks stay in an isolated child
 * process, same harness as gitea-org-mirror-destination.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const CHILD_FLAG = "GITEA_EXISTING_MIRROR_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("existing mirror handling (#496) - isolated child suite", () => {
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

const CLONE_URL = "https://github.com/acme/demo.git";

let claimAnswer: Array<{ id: string }> = [];
let rowWrites: Array<Record<string, any>> = [];
let migrateCalls = 0;
let importFinished = true;
let importPolls = 0;
let repoGone = false;
let syncCalls: Array<{ args: any; importFinishedAtCall: boolean }> = [];
let syncError: Error | null = null;

if (isChild) {
  const repositoriesTable = { __table: "repositories" } as any;

  const rows = (list: any[]) => {
    const promise: any = Promise.resolve(list);
    promise.limit = () => Promise.resolve(list);
    return promise;
  };

  mock.module("@/lib/db", () => ({
    db: {
      select: () => ({ from: () => ({ where: () => rows([]) }) }),
      update: () => ({
        set: (data: Record<string, any>) => {
          rowWrites.push(data);
          return {
            where: () => {
              const result: any = Promise.resolve();
              result.returning = () => Promise.resolve(claimAnswer);
              return result;
            },
          };
        },
      }),
      insert: () => ({ values: () => Promise.resolve() }),
      delete: () => ({ where: () => Promise.resolve() }),
    },
    repositories: repositoriesTable,
    organizations: {},
    configs: {},
    mirrorJobs: {},
    users: {},
    events: {},
    sessions: {},
    accounts: {},
  }));

  mock.module("@/lib/helpers", () => ({ createMirrorJob: mock(async () => "job-id") }));

  mock.module("@/lib/sources", () => ({
    listSources: mock(async () => [
      {
        id: "source-1",
        userId: "user-1",
        name: "GitHub (me)",
        provider: "github",
        url: "https://github.com",
        username: "me",
        token: "gh-token",
        enabled: true,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]),
    findSourceForRepository: (_repo: any, list: any[]) => list[0] ?? null,
    findSourceForOrganization: () => null,
    decryptSourceToken: (token: string | null | undefined) => token ?? "",
    sourceAccessToken: async (source: { token?: string | null }) => source.token ?? "",
    isGitHubAppSource: () => false,
    resolveGitHubApiBaseUrl: () => undefined,
  }));

  const actualHttp = await import("./http-client");
  const actualEnhanced = await import("./gitea-enhanced");
  const actualEncryption = await import("./utils/config-encryption");
  const actualWait = await import("./gitea-import-wait");
  // Kept apart: mock.module patches the namespace above in place, so reading the
  // function from it after the mock is registered would call the mock itself.
  const realWaitForGiteaImport = actualWait.waitForGiteaImport;

  mock.module("@/lib/http-client", () => ({
    ...actualHttp,
    httpGet: mock(async (url: string) => {
      throw new actualHttp.HttpError(`GET ${url} -> 404`, 404, "not found");
    }),
    httpPost: mock(async (url: string) => {
      if (url.includes("/repos/migrate")) migrateCalls++;
      return { data: { id: 1 }, status: 201, statusText: "Created", headers: new Headers() };
    }),
  }));

  mock.module("@/lib/gitea-enhanced", () => ({
    ...actualEnhanced,
    // Gitea's answers during and after an import, as seen on 1.24.7.
    getGiteaRepoInfo: mock(async ({ owner, repoName }: any) => {
      if (repoGone) return null;
      return {
        id: 1,
        name: repoName,
        owner: { login: owner },
        mirror: true,
        private: false,
        original_url: CLONE_URL,
        empty: !importFinished,
        mirror_interval: importFinished ? "8h0m0s" : "",
      };
    }),
    handleExistingNonMirrorRepo: mock(async () => {}),
    syncGiteaRepoEnhanced: mock(async (args: any) => {
      syncCalls.push({ args, importFinishedAtCall: importFinished });
      if (syncError) throw syncError;
    }),
  }));

  mock.module("@/lib/gitea-import-wait", () => ({
    ...actualWait,
    waitForGiteaImport: (args: any) =>
      realWaitForGiteaImport({
        ...args,
        sleep: async () => {
          importPolls++;
          if (importPolls === 2) importFinished = true;
        },
      }),
  }));

  mock.module("@/lib/utils/config-encryption", () => ({
    ...actualEncryption,
    decryptConfigTokens: (config: any) => config,
  }));

  // isRepoPresentInGitea reads the repository through the global fetch.
  globalThis.fetch = mock(async () => new Response("{}", { status: repoGone ? 404 : 200 })) as any;
}

const { mirrorGithubRepoToGitea, mirrorGitHubRepoToGiteaOrg } = isChild
  ? await import("./gitea")
  : ({} as any);

const config = {
  id: "config-1",
  userId: "user-1",
  githubConfig: { token: "gh-token", owner: "me" },
  giteaConfig: {
    url: "https://gitea.test",
    token: "gitea-token",
    defaultOwner: "meuser",
    addTopics: false,
  },
} as any;

const repository = {
  id: "repo-1",
  userId: "user-1",
  configId: "config-1",
  name: "demo",
  fullName: "acme/demo",
  owner: "acme",
  organization: null,
  url: "https://github.com/acme/demo",
  cloneUrl: CLONE_URL,
  sourceProvider: "github",
  sourceUrl: "https://github.com",
  destinationProvider: "gitea",
  destinationUrl: "",
  isPrivate: false,
  isForked: false,
  isStarred: false,
  isArchived: false,
  status: "imported",
  mirroredLocation: "",
} as any;

const paths = [
  {
    name: "user path",
    location: "meuser/demo",
    run: () => mirrorGithubRepoToGitea({ config, octokit: {} as any, repository }),
  },
  {
    name: "organization path",
    location: "acme/demo",
    run: () =>
      mirrorGitHubRepoToGiteaOrg({
        config,
        octokit: {} as any,
        repository,
        giteaOrgId: 5,
        orgName: "acme",
      }),
  },
];

beforeEach(() => {
  claimAnswer = [{ id: "repo-1" }];
  rowWrites = [];
  migrateCalls = 0;
  importFinished = true;
  importPolls = 0;
  repoGone = false;
  syncCalls = [];
  syncError = null;
});

for (const path of paths) {
  describe.skipIf(!isChild)(`existing mirror, ${path.name}`, () => {
    test("runs a full sync instead of only recording that the mirror exists", async () => {
      await path.run();

      expect(migrateCalls).toBe(0);
      expect(syncCalls).toHaveLength(1);
      const { args } = syncCalls[0];
      expect(args.alreadyClaimed).toBe(true);
      expect(args.repository.id).toBe("repo-1");
      expect(args.repository.mirroredLocation).toBe(path.location);
      expect(args.repository.destinationUrl).toBe("https://gitea.test");

      // The row is claimed like any other mirror and never marked done here:
      // that is the sync's to write once the work has happened.
      expect(rowWrites[0]).toMatchObject({ status: "mirroring", mirroredLocation: path.location });
      expect(rowWrites.some((write) => write.status === "mirrored")).toBe(false);
    });

    test("waits for an import Gitea is still running, then syncs", async () => {
      importFinished = false;

      await path.run();

      expect(importPolls).toBe(2);
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].importFinishedAtCall).toBe(true);
    });

    test("fails the row and keeps its location when the sync fails", async () => {
      syncError = new Error("Gitea said no");

      await expect(path.run()).rejects.toThrow("Failed to mirror repository: Gitea said no");

      const failure = rowWrites.at(-1)!;
      expect(failure.status).toBe("failed");
      expect(failure.errorMessage).toBe("Gitea said no");
      expect("mirroredLocation" in failure).toBe(false);
    });

    test("does nothing when another run owns the row", async () => {
      claimAnswer = [];

      await path.run();

      expect(syncCalls).toHaveLength(0);
      expect(migrateCalls).toBe(0);
    });
  });
}
