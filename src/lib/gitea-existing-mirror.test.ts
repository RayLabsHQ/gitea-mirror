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
import { HttpError } from "./http-client";

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
// For the migrate call that goes unanswered (#521).
let existsBeforeMigrate = true;
let existsAfterMigrate = true;
let migrateError: Error | null = null;
let readsAfterMigrate = 0;
// Whether the destination lets the configured token push to the mirror.
let pushAllowed = true;

/** Whether the repository is on the destination at this point of the run. */
const repoThere = () =>
  !repoGone && (migrateCalls === 0 ? existsBeforeMigrate : existsAfterMigrate);

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
      if (url.includes("/repos/migrate")) {
        migrateCalls++;
        if (migrateError) throw migrateError;
      }
      return { data: { id: 1 }, status: 201, statusText: "Created", headers: new Headers() };
    }),
  }));

  mock.module("@/lib/gitea-enhanced", () => ({
    ...actualEnhanced,
    // Gitea's answers during and after an import, as seen on 1.24.7.
    getGiteaRepoInfo: mock(async ({ owner, repoName }: any) => {
      if (!repoThere()) return null;
      if (migrateCalls > 0) readsAfterMigrate++;
      return {
        id: 1,
        name: repoName,
        owner: { login: owner },
        mirror: true,
        private: false,
        original_url: CLONE_URL,
        permissions: { admin: false, push: pushAllowed, pull: true },
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
  globalThis.fetch = mock(async () => new Response("{}", { status: repoThere() ? 200 : 404 })) as any;
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
  existsBeforeMigrate = true;
  existsAfterMigrate = true;
  migrateError = null;
  readsAfterMigrate = 0;
  pushAllowed = true;
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

// The same server answering at a new address: the row still records the old
// one, and the configured server proves it holds the row's mirror.
for (const path of paths) {
  describe.skipIf(!isChild)(`destination moved to a new address, ${path.name}`, () => {
    const run = (overrides: Record<string, unknown>) => {
      Object.assign(repository, overrides);
      return path.run();
    };
    const restore = () =>
      Object.assign(repository, { destinationUrl: "", status: "imported" });

    test("repoints the row at the configured destination and syncs the mirror", async () => {
      try {
        await run({ destinationUrl: "https://gitea-old.test", status: "failed" });
      } finally {
        restore();
      }

      expect(rowWrites[0]).toMatchObject({
        destinationProvider: "gitea",
        destinationUrl: "https://gitea.test",
      });
      expect(migrateCalls).toBe(0);
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].args.repository.mirroredLocation).toBe(path.location);
    });

    test("refuses a mirror of the row's source the configured token cannot push to", async () => {
      pushAllowed = false;
      try {
        await expect(
          run({ destinationUrl: "https://gitea-old.test", status: "failed" })
        ).rejects.toThrow("but the configured destination is Gitea (https://gitea.test)");
      } finally {
        restore();
      }

      expect(rowWrites.some((write) => write.destinationUrl === "https://gitea.test")).toBe(false);
      expect(syncCalls).toHaveLength(0);
    });

    test("still refuses when the configured server has no mirror of the row", async () => {
      repoGone = true;
      try {
        await expect(
          run({ destinationUrl: "https://gitea-old.test", status: "failed" })
        ).rejects.toThrow(
          "is mirrored to Gitea (https://gitea-old.test) but the configured destination is Gitea (https://gitea.test)"
        );
      } finally {
        restore();
      }

      expect(rowWrites.some((write) => write.destinationUrl === "https://gitea.test")).toBe(false);
      expect(migrateCalls).toBe(0);
      expect(syncCalls).toHaveLength(0);
    });
  });
}

// Our request gives up after five minutes (Bun's fetch default) while Gitea, or
// Forgejo, carries on importing a large repository. Failing the mirror there sent
// the retry into a repository with no mirror record yet (#521).
const timedOut = () => new HttpError("Network error: The operation timed out.", 0, "Network Error");

for (const path of paths) {
  describe.skipIf(!isChild)(`migrate call cut off, ${path.name}`, () => {
    beforeEach(() => {
      existsBeforeMigrate = false;
      importFinished = false;
    });

    test("follows the import Gitea carried on with instead of failing", async () => {
      migrateError = timedOut();

      await path.run();

      expect(migrateCalls).toBe(1);
      expect(importPolls).toBe(2);
      expect(rowWrites.some((write) => write.status === "failed")).toBe(false);
      expect(rowWrites.at(-1)).toMatchObject({ status: "mirrored", mirroredLocation: path.location });
    });

    test("a proxy timing out on the call is followed the same way", async () => {
      migrateError = new HttpError("HTTP 504: Gateway Timeout", 504, "Gateway Timeout");

      await path.run();

      expect(importPolls).toBe(2);
      expect(rowWrites.at(-1)).toMatchObject({ status: "mirrored" });
    });

    test("fails as before when Gitea has no such repository", async () => {
      migrateError = timedOut();
      existsAfterMigrate = false;

      await expect(path.run()).rejects.toThrow("The operation timed out.");

      expect(importPolls).toBe(0);
      expect(rowWrites.at(-1)).toMatchObject({ status: "failed" });
    });

    test("an answer from Gitea is reported, not waited on", async () => {
      migrateError = new HttpError("HTTP 422: Unprocessable Entity", 422, "Unprocessable Entity");

      await expect(path.run()).rejects.toThrow("HTTP 422");

      expect(readsAfterMigrate).toBe(0);
      expect(importPolls).toBe(0);
      expect(rowWrites.at(-1)).toMatchObject({ status: "failed" });
    });
  });
}
