/**
 * Tests for Refresh sizes. The destination is a fake fetch that pages like
 * Gitea; the database, the owner lookup, the mirror options and the token
 * decryption are mocked.
 *
 * bun's mock.module is process-wide and leaks into other test files, so in the
 * shared test process this file registers nothing: it re-runs itself in an
 * isolated child process.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const CHILD_FLAG = "GM_STORAGE_REFRESH_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("storage refresh - isolated child suite", () => {
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

const DEST = "https://gitea.example.com";

let configRows: any[] = [];
let repoRows: any[] = [];
let updates: Array<{ id: unknown; values: Record<string, unknown> }> = [];
let releasesFor = new Set<string>();
const mockConfigs = { table: "configs" };
const mockRepositories = { table: "repositories" };

/** Leaf values of a drizzle condition (drizzle conditions are cyclic). */
function conditionLeafValues(node: any, depth = 0): unknown[] {
  if (node == null || depth > 8) return [];
  if (typeof node !== "object") return [node];
  const leaves: unknown[] = [];
  if (Array.isArray(node.value)) leaves.push(...node.value);
  else if ("value" in node && typeof node.value !== "object") leaves.push(node.value);
  for (const chunk of node.queryChunks ?? []) {
    leaves.push(...conditionLeafValues(chunk, depth + 1));
  }
  return leaves;
}

const mockGetOwner = mock(async ({ repository }: any) => repository.expectedOwner ?? "");

if (isChild) {
  mock.module("@/lib/db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            table === mockConfigs
              ? { orderBy: () => ({ limit: async () => configRows }) }
              : Promise.resolve(repoRows),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async (cond: unknown) => {
            // The id is the one leaf that is not an SQL fragment ("", " = ").
            const id = conditionLeafValues(cond).find((v) => typeof v === "string" && !/^\s*=?\s*$/.test(v));
            updates.push({ id, values });
          },
        }),
      }),
    },
    configs: mockConfigs,
    repositories: mockRepositories,
    organizations: {},
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

  mock.module("@/lib/gitea", () => ({
    getGiteaRepoOwnerAsync: mockGetOwner,
  }));

  mock.module("@/lib/utils/mirror-overrides", () => ({
    resolveMirrorOptionsForRepository: async ({ repository }: any) => ({
      mirrorReleases: releasesFor.has(repository.id),
    }),
  }));

  mock.module("@/lib/utils/config-encryption", () => ({
    decryptConfigTokens: (config: any) => config,
  }));
}

const { startStorageRefresh, getStorageRefreshProgress, waitForStorageRefresh } = isChild
  ? await import("./storage-refresh")
  : ({} as typeof import("./storage-refresh"));

const realFetch = globalThis.fetch;
let requestedUrls: string[] = [];

interface FakeDestination {
  /** Repositories per owner, as the owner listing returns them. */
  owners?: Record<string, Array<Record<string, unknown>>>;
  /** Single GET answers by "owner/name"; a number is an error status. */
  single?: Record<string, Record<string, unknown> | number>;
  /** Releases by "owner/name"; a number is an error status. */
  releases?: Record<string, Array<Record<string, unknown>> | number>;
  /** Held until released, to keep a run going. */
  gate?: Promise<void>;
}

function json(data: unknown, total?: number) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (total !== undefined) headers["x-total-count"] = String(total);
  return new Response(JSON.stringify(data), { status: 200, headers });
}

function serve(world: FakeDestination) {
  requestedUrls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    await world.gate;
    const { pathname, searchParams } = new URL(url);
    const page = Number(searchParams.get("page") ?? "1");
    const parts = pathname.split("/").map(decodeURIComponent);

    // /api/v1/users/{owner}/repos
    if (parts[3] === "users" && parts[5] === "repos") {
      const all = world.owners?.[parts[4]];
      if (!all) return new Response("not found", { status: 404, statusText: "Not Found" });
      return json(all.slice((page - 1) * 50, page * 50), all.length);
    }
    // /api/v1/repos/{owner}/{name}/releases
    if (parts[3] === "repos" && parts[6] === "releases") {
      const answer = world.releases?.[`${parts[4]}/${parts[5]}`] ?? [];
      if (typeof answer === "number") return new Response("boom", { status: answer, statusText: "Error" });
      return json(answer.slice((page - 1) * 50, page * 50), answer.length);
    }
    // /api/v1/repos/{owner}/{name}
    if (parts[3] === "repos" && parts.length === 6) {
      const answer = world.single?.[`${parts[4]}/${parts[5]}`] ?? 404;
      if (typeof answer === "number") return new Response("nope", { status: answer, statusText: "Error" });
      return json(answer);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

function repo(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: "user-1",
    name: id,
    fullName: `octo/${id}`,
    mirroredLocation: `archive/${id}`,
    status: "mirrored",
    destinationProvider: "gitea",
    destinationSize: null,
    releaseAssetsSize: null,
    releaseAssetsCount: null,
    ...overrides,
  };
}

function destRepo(name: string, sizeKiB: number, extra: Record<string, unknown> = {}) {
  return { name, owner: { login: "archive" }, mirror: true, size: sizeKiB, ...extra };
}

async function refresh() {
  const started = await startStorageRefresh("user-1");
  await waitForStorageRefresh("user-1");
  return { started, progress: getStorageRefreshProgress("user-1") };
}

function writesFor(id: string) {
  return updates.filter((u) => u.id === id).map((u) => u.values);
}

beforeEach(() => {
  configRows = [{ userId: "user-1", isActive: true, giteaConfig: { url: `${DEST}/`, token: "dest-token", provider: "gitea" } }];
  repoRows = [];
  updates = [];
  releasesFor = new Set();
  mockGetOwner.mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe.skipIf(!isChild)("Refresh sizes", () => {
  test("reads sizes from one listing per owner and releases only where they are mirrored", async () => {
    repoRows = [repo("app"), repo("lib")];
    releasesFor = new Set(["app"]);
    serve({
      owners: { archive: [destRepo("app", 2959), destRepo("lib", 10), destRepo("not-ours", 99)] },
      releases: { "archive/app": [{ assets: [{ size: 1000 }, { size: 24 }] }, { assets: [] }] },
    });

    const { started, progress } = await refresh();

    expect(started).toMatchObject({ ok: true, progress: { running: true, total: 2 } });
    expect(progress).toMatchObject({ running: false, total: 2, done: 2, measured: 2, missing: 0, failed: 0 });
    expect(writesFor("app")).toEqual([
      expect.objectContaining({ destinationSize: 2959 * 1024, releaseAssetsSize: 1024, releaseAssetsCount: 2 }),
    ]);
    expect(writesFor("lib")).toEqual([expect.objectContaining({ destinationSize: 10 * 1024 })]);
    expect(writesFor("lib")[0]).not.toHaveProperty("releaseAssetsSize");
    expect(writesFor("lib")[0].storageCheckedAt).toBeInstanceOf(Date);

    const ownerListings = requestedUrls.filter((u) => u.includes("/users/"));
    expect(ownerListings).toEqual([`${DEST}/api/v1/users/archive/repos?limit=50&page=1`]);
    expect(requestedUrls.filter((u) => u.includes("/releases"))).toHaveLength(1);
    // Only the destination is contacted.
    expect(requestedUrls.every((u) => u.startsWith(`${DEST}/api/v1/`))).toBe(true);
  });

  test("pages through an owner with more repositories than one page", async () => {
    const many = Array.from({ length: 120 }, (_, i) => destRepo(`r${i}`, i + 1));
    repoRows = [repo("r119")];
    serve({ owners: { archive: many } });

    const { progress } = await refresh();

    expect(progress?.measured).toBe(1);
    expect(writesFor("r119")[0].destinationSize).toBe(120 * 1024);
    expect(requestedUrls.filter((u) => u.includes("/users/"))).toHaveLength(3);
  });

  test("falls back to the single GET for a repository the listing does not have", async () => {
    repoRows = [repo("renamed"), repo("gone")];
    serve({
      owners: { archive: [] },
      single: { "archive/renamed": destRepo("new-name", 5) },
    });

    const { progress } = await refresh();

    expect(progress).toMatchObject({ measured: 1, missing: 1, failed: 0 });
    expect(writesFor("renamed")[0].destinationSize).toBe(5 * 1024);
    expect(writesFor("gone")).toEqual([]);
  });

  test("reads releases at the name the destination reports", async () => {
    repoRows = [repo("renamed")];
    releasesFor = new Set(["renamed"]);
    serve({
      owners: { archive: [] },
      single: { "archive/renamed": destRepo("new-name", 5) },
      releases: { "archive/new-name": [{ assets: [{ size: 7 }] }] },
    });

    await refresh();

    expect(writesFor("renamed")[0]).toMatchObject({ releaseAssetsSize: 7, releaseAssetsCount: 1 });
  });

  test("a failed owner listing leaves its repositories to the single GET", async () => {
    repoRows = [repo("app")];
    serve({ single: { "archive/app": destRepo("app", 3) } });

    const { progress } = await refresh();

    expect(progress?.measured).toBe(1);
    expect(requestedUrls).toContain(`${DEST}/api/v1/repos/archive/app`);
  });

  test("without a recorded location, measures only a mirror where a sync would look", async () => {
    repoRows = [
      repo("placed", { mirroredLocation: null, expectedOwner: "me" }),
      repo("someone-elses", { mirroredLocation: null, expectedOwner: "me" }),
    ];
    serve({
      owners: { me: [destRepo("placed", 4), destRepo("someone-elses", 8, { mirror: false })] },
    });

    const { progress } = await refresh();

    expect(mockGetOwner).toHaveBeenCalledTimes(2);
    expect(progress).toMatchObject({ measured: 1, missing: 1 });
    expect(writesFor("placed")[0].destinationSize).toBe(4 * 1024);
    expect(writesFor("someone-elses")).toEqual([]);
  });

  test("an incomplete release listing keeps the stored release numbers", async () => {
    repoRows = [repo("app")];
    releasesFor = new Set(["app"]);
    serve({ owners: { archive: [destRepo("app", 2)] }, releases: { "archive/app": 500 } });

    const { progress } = await refresh();

    expect(progress?.measured).toBe(1);
    expect(writesFor("app")[0]).toHaveProperty("destinationSize", 2048);
    expect(writesFor("app")[0]).not.toHaveProperty("releaseAssetsSize");
  });

  test("counts a request that fails and writes nothing for it", async () => {
    repoRows = [repo("app")];
    serve({ owners: { archive: [] }, single: { "archive/app": 500 } });

    const { progress } = await refresh();

    expect(progress).toMatchObject({ running: false, done: 1, measured: 0, failed: 1 });
    expect(updates).toEqual([]);
  });

  test("measures the rows the storage page counts as mirrors, and no others", async () => {
    repoRows = [
      repo("app"),
      repo("pushed", { destinationProvider: "gitlab" }),
      repo("imported", { status: "imported", mirroredLocation: null }),
      repo("failed-but-measured", { status: "failed", destinationSize: 10 }),
    ];
    serve({ owners: { archive: [destRepo("app", 1), destRepo("failed-but-measured", 2)] } });

    const { progress } = await refresh();

    expect(progress).toMatchObject({ total: 2, measured: 2 });
  });

  test("refuses without a destination token or with a push destination", async () => {
    serve({});
    configRows = [{ userId: "user-1", giteaConfig: { url: DEST, token: "", provider: "gitea" } }];
    expect(await startStorageRefresh("user-1")).toMatchObject({ ok: false, status: 400 });

    configRows = [{ userId: "user-1", giteaConfig: { url: "https://gitlab.com", token: "t", provider: "gitlab" } }];
    expect(await startStorageRefresh("user-1")).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("Gitea and Forgejo"),
    });
    expect(requestedUrls).toEqual([]);
  });

  test("a second start while a run is going reports that run instead of starting another", async () => {
    repoRows = [repo("app")];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    serve({ owners: { archive: [destRepo("app", 1)] }, gate });

    const first = await startStorageRefresh("user-1");
    const second = await startStorageRefresh("user-1");
    expect(first).toMatchObject({ ok: true, progress: { running: true } });
    expect(second).toMatchObject({ ok: true, progress: { running: true, startedAt: (first as any).progress.startedAt } });

    open();
    await waitForStorageRefresh("user-1");
    expect(requestedUrls.filter((u) => u.includes("/users/"))).toHaveLength(1);
    expect(getStorageRefreshProgress("user-1")).toMatchObject({ running: false, measured: 1 });
  });
});
