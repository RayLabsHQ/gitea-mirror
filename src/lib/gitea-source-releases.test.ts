/**
 * Behavioural tests for source aware release mirroring (#440).
 *
 * Release mirroring used to call the GitHub API unconditionally and download
 * every asset with the primary config's GitHub token. A Gitea or Forgejo
 * source (Codeberg included) now lists its own releases and downloads its own
 * assets with its own credentials, while the GitHub path keeps its exact
 * previous behaviour, including the "Originally published on GitHub:" header
 * line, which must stay byte for byte or every mirrored release body would
 * differ and be PATCHed on the next sync.
 *
 * Both entry points are driven through a fake global fetch, which is what the
 * destination client, the source adapter and the asset reconciliation all use.
 * Other test files replace @/lib/http-client and friends with mock.module,
 * which is process-wide in bun and depends on file order, so the suites here
 * run in an isolated child process (same harness as
 * gitea-org-mirror-destination.test.ts) where the real modules are loaded.
 */

import { afterEach, describe, expect, it, mock, test } from "bun:test";
import type { Config } from "@/types/config";
import type { Repository } from "@/lib/db/schema";
import type { SourceConnection } from "@/lib/source-providers/types";

const CHILD_FLAG = "GM_SOURCE_RELEASES_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("source aware release mirroring - isolated child suite", () => {
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

// Both gitea.ts and helpers.ts bind to the notification service. Replace it in
// the child before importing them so the all-releases-removed warning can be
// captured without loading providers or touching the database.
interface RemovalNotice {
  userId: string;
  repositoryName: string;
  destination: string;
  removedCount: number;
}
let removalNotices: RemovalNotice[] = [];

// gitea.ts is the only module that pulls ./helpers into this import graph and
// only uses createMirrorJob from it. Capture the activity rows it writes so the
// all-releases-removed warning can be asserted without touching the database.
interface ActivityJob {
  status: string;
  message?: string;
  details?: string;
  skipNotification?: boolean;
  skipDuplicateEvent?: boolean;
}
let activityJobs: ActivityJob[] = [];

// The release asset totals the retention pass records for the storage page.
interface StorageRecord {
  repositoryId: string | null | undefined;
  summary: { count: number; bytes: number };
}
let storageRecords: StorageRecord[] = [];

if (isChild) {
  mock.module("@/lib/repository-storage-store", () => ({
    recordReleaseAssetStorage: async (
      repositoryId: string | null | undefined,
      summary: { count: number; bytes: number }
    ) => {
      storageRecords.push({ repositoryId, summary });
    },
  }));
  mock.module("@/lib/notification-service", () => ({
    triggerAllReleasesRemovedNotification: async (notice: RemovalNotice) => {
      removalNotices.push(notice);
    },
    triggerJobNotification: async () => {},
  }));
  mock.module("@/lib/helpers", () => ({
    createMirrorJob: async (job: ActivityJob) => {
      activityJobs.push(job);
      return "activity-job";
    },
  }));
}

const { clearAllRateLimits, markRateLimited, rateLimitGateKey } = await import("@/lib/rate-limit-gate");
const { mirrorGiteaSourceReleasesToGitea, mirrorGitHubReleasesToGitea } = isChild
  ? await import("@/lib/gitea")
  : ({} as typeof import("@/lib/gitea"));
const GITEA_URL = "https://gitea.example.com";
const SOURCE_URL = "https://codeberg.org";
const DEST_OWNER = "mirror-owner";
const DEST_REPO = "demo";
const DEST_API = `${GITEA_URL}/api/v1/repos/${DEST_OWNER}/${DEST_REPO}`;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  removalNotices = [];
  activityJobs = [];
  storageRecords = [];
});

const config = {
  userId: "user-1",
  githubConfig: { owner: "acme", token: "github-token" },
  giteaConfig: { url: GITEA_URL, token: "gitea-token", defaultOwner: DEST_OWNER },
} as unknown as Partial<Config>;

const repository = {
  id: "repo-1",
  name: DEST_REPO,
  fullName: "acme/demo",
  owner: "acme",
  isStarred: false,
  mirrorOverrides: null,
  organization: null,
} as unknown as Repository;

function giteaConnection(token: string): SourceConnection {
  return { provider: "gitea", url: SOURCE_URL, username: "acme", token };
}

interface Recorded {
  method: string;
  url: string;
  authorization: string | null;
  body?: string;
}

interface DestinationOptions {
  /** Releases the source reports, newest first. */
  sourceReleases: Array<Record<string, unknown>>;
  /**
   * Serve the source listing page by page (`limit` and `page`, with
   * X-Total-Count) instead of every release on every page.
   */
  sourcePaged?: boolean;
  /** Release already on the destination, matched by tag. */
  existingRelease?: { id: number; name: string; body: string; tag_name: string };
  /** Tags the destination already has. Defaults to every source tag. */
  destinationTags?: string[];
  /** Releases already on the destination, as the retention pass lists them. */
  destinationReleases?: Array<Record<string, unknown>>;
  /** The destination answers the retention listing with an error. */
  destinationListingFails?: boolean;
  /**
   * Serve the listing this many releases per page at most, with
   * X-Total-Count, as Gitea does (30 when asked with `per_page`).
   */
  destinationPageCap?: number;
  /** Destination release ids whose DELETE fails. */
  failDeleteIds?: number[];
  /** Attachments a destination release has, keyed by release id. */
  destinationAssets?: Record<string, Array<{ id: number; name: string; size: number }>>;
  /** Attachment ids whose DELETE fails. */
  failAssetDeleteIds?: number[];
  /** Release ids whose attachment listing answers with an error. */
  failAssetListingFor?: number[];
}

function fakeWorld(options: DestinationOptions) {
  const requests: Recorded[] = [];
  const tags =
    options.destinationTags ??
    options.sourceReleases.map((release) => String(release.tag_name));

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url, authorization: headers.get("authorization"), body });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    // The source lists its releases.
    if (url.startsWith(`${SOURCE_URL}/api/v1/`)) {
      if (!options.sourcePaged) return json(options.sourceReleases);
      const params = new URL(url).searchParams;
      const size = Number(params.get("limit") ?? "30");
      const page = Number(params.get("page") ?? "1");
      return new Response(
        JSON.stringify(options.sourceReleases.slice((page - 1) * size, page * size)),
        {
          headers: {
            "content-type": "application/json",
            "x-total-count": String(options.sourceReleases.length),
          },
        }
      );
    }

    // Downloading an asset from the source host.
    if (
      url.startsWith(`${SOURCE_URL}/attachments/`) ||
      url.startsWith("https://github.com/") ||
      url.startsWith("https://api.github.com/")
    ) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }

    // The destination repository exists.
    if (method === "GET" && url === DEST_API) {
      return json({ id: 1, name: DEST_REPO });
    }

    // Does the release already exist for this tag?
    if (method === "GET" && url.startsWith(`${DEST_API}/releases/tags/`)) {
      return options.existingRelease
        ? json(options.existingRelease)
        : new Response("not found", { status: 404 });
    }

    // Is the git tag synced yet?
    if (method === "GET" && url.startsWith(`${DEST_API}/tags/`)) {
      const tag = decodeURIComponent(url.slice(`${DEST_API}/tags/`.length));
      return tags.includes(tag)
        ? json({ name: tag })
        : new Response("not found", { status: 404 });
    }

    // Existing attachments of a release.
    if (method === "GET" && /\/releases\/\d+\/assets$/.test(url)) {
      const releaseId = Number(url.match(/\/releases\/(\d+)\/assets$/)?.[1]);
      if (options.failAssetListingFor?.includes(releaseId)) {
        return new Response("boom", { status: 500 });
      }
      return json(options.destinationAssets?.[String(releaseId)] ?? []);
    }

    // Pruning the attachments of a release that is past the asset limit.
    if (method === "DELETE" && /\/releases\/\d+\/assets\/\d+$/.test(url)) {
      const assetId = Number(url.slice(url.lastIndexOf("/") + 1));
      return options.failAssetDeleteIds?.includes(assetId)
        ? new Response("boom", { status: 500 })
        : new Response(null, { status: 204 });
    }

    // Uploading an attachment.
    if (method === "POST" && url.includes("/assets?name=")) {
      return json({ id: 900 }, 201);
    }

    // Creating a release.
    if (method === "POST" && url === `${DEST_API}/releases`) {
      return json({ id: 77 }, 201);
    }

    // Updating a release.
    if (method === "PATCH" && /\/releases\/\d+$/.test(url)) {
      return json({ id: 77 });
    }

    // The retention pass removing a release.
    if (method === "DELETE" && /\/releases\/\d+$/.test(url)) {
      const id = Number(url.slice(url.lastIndexOf("/") + 1));
      return options.failDeleteIds?.includes(id)
        ? new Response("boom", { status: 500 })
        : new Response(null, { status: 204 });
    }

    // The retention pass lists everything the destination has.
    if (method === "GET" && url.startsWith(`${DEST_API}/releases?`)) {
      if (options.destinationListingFails) return new Response("boom", { status: 500 });
      const listed = options.destinationReleases ?? [];
      if (!options.destinationPageCap) return json(listed);
      const params = new URL(url).searchParams;
      const size = Math.min(Number(params.get("limit") ?? "30"), options.destinationPageCap);
      const page = Number(params.get("page") ?? "1");
      return new Response(JSON.stringify(listed.slice((page - 1) * size, page * size)), {
        headers: { "content-type": "application/json", "x-total-count": String(listed.length) },
      });
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return {
    requests,
    creates: () => requests.filter((r) => r.method === "POST" && r.url === `${DEST_API}/releases`),
    patches: () => requests.filter((r) => r.method === "PATCH"),
    deletes: () => requests.filter((r) => r.method === "DELETE"),
    /** Tags of every release the mirror created on the destination. */
    createdTags: () =>
      requests
        .filter((r) => r.method === "POST" && r.url === `${DEST_API}/releases`)
        .map((r) => String(JSON.parse(r.body ?? "{}").tag_name)),
    uploads: () => requests.filter((r) => r.method === "POST" && r.url.includes("/assets?name=")),
    sourceListings: () => requests.filter((r) => r.url.startsWith(`${SOURCE_URL}/api/v1/`)),
    downloads: () =>
      requests.filter(
        (r) =>
          r.url.startsWith(`${SOURCE_URL}/attachments/`) ||
          r.url.startsWith("https://github.com/") ||
          r.url.startsWith("https://api.github.com/")
      ),
    assetListings: () =>
      requests.filter((r) => r.method === "GET" && /\/releases\/\d+\/assets$/.test(r.url)),
    assetDeletes: () =>
      requests.filter((r) => r.method === "DELETE" && /\/releases\/\d+\/assets\/\d+$/.test(r.url)),
  };
}

function giteaRelease(tag: string, extra: Record<string, unknown> = {}) {
  return {
    id: 5,
    tag_name: tag,
    name: `Release ${tag}`,
    body: `notes for ${tag}`,
    draft: false,
    prerelease: false,
    created_at: "2026-01-01T00:00:00Z",
    published_at: "2026-01-01T00:00:00Z",
    assets: [],
    ...extra,
  };
}

function mirrorFromGitea(
  connection: SourceConnection,
  overrides: {
    releaseLimit?: number;
    releaseType?: "all" | "stable";
    releaseIncludeTags?: string[];
    releaseExcludeTags?: string[];
    prereleaseLimit?: number | null;
  } = {}
) {
  return mirrorGiteaSourceReleasesToGitea({
    config,
    repository,
    connection,
    giteaOwner: DEST_OWNER,
    giteaRepoName: DEST_REPO,
    releaseLimit: overrides.releaseLimit ?? 10,
    releaseAssetLimit: null,
    prereleaseLimit: overrides.prereleaseLimit,
    releaseType: overrides.releaseType,
    releaseIncludeTags: overrides.releaseIncludeTags,
    releaseExcludeTags: overrides.releaseExcludeTags,
  });
}

/** A destination release as the retention pass reads it. */
function destinationRelease(tag: string, id: number, prerelease: boolean | null) {
  return {
    id,
    tag_name: tag,
    created_at: `2026-0${Math.max(1, 9 - id % 9)}-01T00:00:00Z`,
    prerelease,
  };
}

describe.skipIf(!isChild)("mirrorGiteaSourceReleasesToGitea", () => {
  it("creates a missing release with the Gitea/Forgejo header", async () => {
    const world = fakeWorld({ sourceReleases: [giteaRelease("v1.0.0")] });

    await mirrorFromGitea(giteaConnection("source-token"));

    const [create] = world.creates();
    expect(create).toBeDefined();
    const payload = JSON.parse(create.body!);
    expect(payload.tag_name).toBe("v1.0.0");
    expect(payload.name).toBe("Release v1.0.0");
    expect(payload.body).toBe(
      "> 📅 **Originally published on Gitea / Forgejo:** Thu, 01 Jan 2026 00:00:00 GMT\n\nnotes for v1.0.0"
    );
    // The destination is always addressed with the destination token.
    expect(create.authorization).toBe("token gitea-token");
  });

  it("updates an existing release whose body drifted", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v1.0.0")],
      existingRelease: {
        id: 77,
        tag_name: "v1.0.0",
        name: "Release v1.0.0",
        body: "stale body",
      },
    });

    await mirrorFromGitea(giteaConnection("source-token"));

    expect(world.creates()).toHaveLength(0);
    const [patch] = world.patches();
    expect(patch.url).toBe(`${DEST_API}/releases/77`);
    expect(JSON.parse(patch.body!).body).toContain(
      "**Originally published on Gitea / Forgejo:**"
    );
  });

  it("leaves a release alone when the body and title already match", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v1.0.0")],
      existingRelease: {
        id: 77,
        tag_name: "v1.0.0",
        name: "Release v1.0.0",
        body:
          "> 📅 **Originally published on Gitea / Forgejo:** Thu, 01 Jan 2026 00:00:00 GMT\n\nnotes for v1.0.0",
      },
    });

    await mirrorFromGitea(giteaConnection("source-token"));

    expect(world.creates()).toHaveLength(0);
    expect(world.patches()).toHaveLength(0);
  });

  it("skips a release whose git tag has not reached the destination yet", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v1.0.0")],
      destinationTags: [],
    });

    await mirrorFromGitea(giteaConnection("source-token"));

    expect(world.creates()).toHaveLength(0);
  });

  it("downloads assets with the source instance's token, never the GitHub one", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v1.0.0", {
          assets: [
            {
              id: 1,
              name: "firmware.bin",
              size: 4,
              browser_download_url: `${SOURCE_URL}/attachments/abc`,
            },
          ],
        }),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"));

    const [download] = world.downloads();
    expect(download.url).toBe(`${SOURCE_URL}/attachments/abc`);
    expect(download.authorization).toBe("token source-token");
    expect(world.uploads()).toHaveLength(1);
    // No request anywhere carried the GitHub token.
    expect(
      world.requests.some((r) => r.authorization === "token github-token")
    ).toBe(false);
  });

  it("downloads assets with no Authorization header from a tokenless public source", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v1.0.0", {
          assets: [
            {
              id: 1,
              name: "firmware.bin",
              size: 4,
              browser_download_url: `${SOURCE_URL}/attachments/abc`,
            },
          ],
        }),
      ],
    });

    await mirrorFromGitea(giteaConnection(""));

    const [download] = world.downloads();
    expect(download.authorization).toBeNull();
    // The source listing is anonymous too.
    const listing = world.requests.find((r) => r.url.startsWith(`${SOURCE_URL}/api/v1/`));
    expect(listing?.authorization).toBeNull();
  });
});

describe.skipIf(!isChild)("release type filter", () => {
  it("mirrors only the releases the source does not flag as pre-release", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v2.1.0-beta.1", { prerelease: true }),
        giteaRelease("v2.0.0"),
        giteaRelease("v1.0.0"),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseType: "stable" });

    expect(world.createdTags()).toEqual(["v2.0.0", "v1.0.0"]);
  });

  it("mirrors every release when a stored value names a kind that no longer exists", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v2.1.0-beta.1", { prerelease: true }),
        giteaRelease("v2.0.0"),
      ],
    });

    // A row saved while the filter offered pre-releases on their own must not
    // turn into a filter nobody asked for; it falls back to no type filter.
    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseType: "prerelease" as unknown as "stable",
    });

    expect(world.createdTags()).toEqual(["v2.1.0-beta.1", "v2.0.0"]);
  });

  it("looks further back so the limit counts the releases that match", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v3.0.0-rc1", { prerelease: true }),
        giteaRelease("v2.0.0"),
        giteaRelease("v1.0.0"),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseLimit: 1,
      releaseType: "stable",
    });

    // Asking the source for a single release would leave the pre-release as the
    // only candidate; the filter widens the scan instead, so "the newest one"
    // is the newest stable one.
    expect(world.createdTags()).toEqual(["v2.0.0"]);
    const listing = world.requests.find((r) => r.url.startsWith(`${SOURCE_URL}/api/v1/`));
    expect(listing?.url).toContain("limit=50&page=1");
  });

  it("removes destination releases the filter excludes", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [
        destinationRelease("v1.9.0-beta", 11, true),
        destinationRelease("v1.8.0", 12, false),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseType: "stable" });

    expect(world.deletes().map((r) => r.url)).toEqual([`${DEST_API}/releases/11`]);
  });

  it("keeps a destination release whose pre-release flag is unknown", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [destinationRelease("v1.8.0", 12, null)],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseType: "stable" });

    expect(world.deletes()).toHaveLength(0);
  });

  it("still runs retention when the filter excludes every source release", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.1.0-beta.1", { prerelease: true })],
      destinationReleases: [destinationRelease("v2.1.0-beta.1", 21, true)],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseType: "stable" });

    expect(world.creates()).toHaveLength(0);
    expect(world.deletes().map((r) => r.url)).toEqual([`${DEST_API}/releases/21`]);
  });

  it("leaves the destination alone when every release is a candidate", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [destinationRelease("v1.9.0-beta", 11, true)],
    });

    await mirrorFromGitea(giteaConnection("source-token"));

    expect(world.deletes()).toHaveLength(0);
  });
});

describe.skipIf(!isChild)("pre-release limit (#560)", () => {
  /** A nightly build every day: `count` pre-releases, newest first, from b<start> down. */
  const nightlies = (start: number, count: number) =>
    Array.from({ length: count }, (_, index) =>
      giteaRelease(`b${start - index}`, { prerelease: true })
    );

  it("keeps the newest pre-releases and gives the other places to stable releases", async () => {
    const world = fakeWorld({
      sourceReleases: [
        ...nightlies(9000, 4),
        giteaRelease("v2.0.0"),
        ...nightlies(8000, 3),
        giteaRelease("v1.0.0"),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 4, prereleaseLimit: 2 });

    expect(world.createdTags()).toEqual(["b9000", "b8999", "v2.0.0", "v1.0.0"]);
  });

  it("0 mirrors stable releases only", async () => {
    const world = fakeWorld({
      sourceReleases: [...nightlies(9000, 3), giteaRelease("v2.0.0"), giteaRelease("v1.0.0")],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 5, prereleaseLimit: 0 });

    expect(world.createdTags()).toEqual(["v2.0.0", "v1.0.0"]);
  });

  it("looks past hundreds of nightly builds for the stable releases, and stops there", async () => {
    // The stable releases sit on the fifth page of 50; a sixth page exists.
    const world = fakeWorld({
      sourcePaged: true,
      sourceReleases: [
        ...nightlies(9000, 220),
        giteaRelease("v2.0.0"),
        giteaRelease("v1.0.0"),
        ...nightlies(8000, 100),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 3, prereleaseLimit: 1 });

    expect(world.createdTags()).toEqual(["b9000", "v2.0.0", "v1.0.0"]);
    expect(world.sourceListings().map((r) => new URL(r.url).searchParams.get("page"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("reads a single page when the first page already fills the limit", async () => {
    const world = fakeWorld({
      sourcePaged: true,
      sourceReleases: [
        giteaRelease("b2", { prerelease: true }),
        giteaRelease("v3.0.0"),
        giteaRelease("v2.0.0"),
        ...nightlies(1000, 200),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 3, prereleaseLimit: 1 });

    expect(world.createdTags()).toEqual(["b2", "v3.0.0", "v2.0.0"]);
    expect(world.sourceListings()).toHaveLength(1);
  });

  it("removes destination pre-releases past the limit, newest by the source's order kept", async () => {
    const world = fakeWorld({
      sourceReleases: [...nightlies(9000, 3), giteaRelease("v2.0.0")],
      destinationReleases: [
        // Created on the destination in an order that disagrees with the
        // source: b8999 looks newest by date but the source ranks it second.
        { id: 31, tag_name: "b9000", created_at: "2026-01-01T00:00:00Z", prerelease: true },
        { id: 32, tag_name: "b8999", created_at: "2026-03-01T00:00:00Z", prerelease: true },
        { id: 33, tag_name: "b8998", created_at: "2026-02-01T00:00:00Z", prerelease: true },
        // Gone from the source: ranks after everything it still lists.
        { id: 34, tag_name: "b7000", created_at: "2026-04-01T00:00:00Z", prerelease: true },
        { id: 35, tag_name: "v2.0.0", created_at: "2025-12-01T00:00:00Z", prerelease: false },
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 10, prereleaseLimit: 2 });

    expect(world.deletes().map((r) => r.url).sort()).toEqual([
      `${DEST_API}/releases/33`,
      `${DEST_API}/releases/34`,
    ]);
  });

  it("keeps a destination release whose pre-release flag is unknown", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [
        destinationRelease("b1", 41, null),
        destinationRelease("b0", 42, true),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { prereleaseLimit: 0 });

    expect(world.deletes().map((r) => r.url)).toEqual([`${DEST_API}/releases/42`]);
  });

  it("changes nothing when only stable releases are mirrored", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("b1", { prerelease: true }), giteaRelease("v2.0.0")],
      destinationReleases: [destinationRelease("v1.0.0", 51, false)],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseType: "stable",
      prereleaseLimit: 3,
    });

    expect(world.createdTags()).toEqual(["v2.0.0"]);
    expect(world.deletes()).toHaveLength(0);
  });

  it("stable only finds a stable release behind hundreds of pre-releases (#538)", async () => {
    // llama.cpp: every build is a pre-release, about 195 on top of v1.0.0.
    const world = fakeWorld({
      sourcePaged: true,
      sourceReleases: [...nightlies(9000, 195), giteaRelease("v1.0.0"), ...nightlies(8000, 300)],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 1, releaseType: "stable" });

    expect(world.createdTags()).toEqual(["v1.0.0"]);
    // Four pages of 50 reach it, and the listing stops there.
    expect(world.sourceListings()).toHaveLength(4);
  });

  it("tag patterns alone keep the 100 release window, and stop once the limit is filled", async () => {
    const world = fakeWorld({
      sourcePaged: true,
      sourceReleases: [giteaRelease("v3.0.0"), giteaRelease("v2.0.0"), ...nightlies(9000, 300)],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseLimit: 2,
      releaseIncludeTags: ["v*"],
    });

    expect(world.createdTags()).toEqual(["v3.0.0", "v2.0.0"]);
    expect(world.sourceListings()).toHaveLength(1);

    const sparse = fakeWorld({
      sourcePaged: true,
      sourceReleases: [giteaRelease("v3.0.0"), ...nightlies(9000, 300)],
    });
    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseLimit: 2,
      releaseIncludeTags: ["v*"],
    });
    // Never filled: two pages of 50, the 100 release window, and no more.
    expect(sparse.sourceListings()).toHaveLength(2);
  });

  it("without a limit, pre-releases count like any other release, as before", async () => {
    const world = fakeWorld({
      sourceReleases: [...nightlies(9000, 3), giteaRelease("v2.0.0")],
      destinationReleases: [destinationRelease("b8000", 61, true)],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 3 });

    expect(world.createdTags()).toEqual(["b9000", "b8999", "b8998"]);
    expect(world.sourceListings()[0]?.url).toContain("limit=3&page=1");
    // The destination's own pre-release is not removed for being one.
    expect(world.deletes()).toHaveLength(0);
  });

  it("reads the limit from the stored config when the caller passes none", async () => {
    const world = fakeWorld({
      sourceReleases: [...nightlies(9000, 3), giteaRelease("v2.0.0")],
    });

    await mirrorGiteaSourceReleasesToGitea({
      config: {
        ...config,
        giteaConfig: { ...(config.giteaConfig as object), prereleaseLimit: 1 },
      } as Partial<Config>,
      repository,
      connection: giteaConnection("source-token"),
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      releaseLimit: 2,
      releaseAssetLimit: null,
    });

    expect(world.createdTags()).toEqual(["b9000", "v2.0.0"]);
  });

  it("stops the GitHub listing at the first page that fills the limit", async () => {
    fakeWorld({ sourceReleases: [], destinationTags: ["b3", "b2", "v1.0.0", "v0.9.0"] });
    const pagesAsked: Array<{ page: number; per_page: number }> = [];
    const pages: Record<number, Array<Record<string, unknown>>> = {
      1: [giteaRelease("b3", { prerelease: true }), giteaRelease("b2", { prerelease: true })],
      2: [giteaRelease("v1.0.0"), giteaRelease("v0.9.0")],
      3: [giteaRelease("v0.8.0")],
    };
    // Two releases a page, so the stable ones arrive on page 2.
    const octokit = {
      rest: {
        repos: {
          listReleases: async ({ page, per_page }: { page: number; per_page: number }) => {
            pagesAsked.push({ page, per_page });
            const data = (pages[page] ?? []).concat(
              Array.from({ length: per_page - (pages[page]?.length ?? 0) }, (_, index) =>
                page < 3 ? giteaRelease(`filler-${page}-${index}`, { prerelease: true }) : null
              ).filter(Boolean) as Array<Record<string, unknown>>
            );
            return { data };
          },
        },
      },
    } as any;

    await mirrorGitHubReleasesToGitea({
      config,
      octokit,
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      releaseLimit: 3,
      releaseAssetLimit: null,
      prereleaseLimit: 1,
    });

    expect(pagesAsked).toEqual([
      { page: 1, per_page: 100 },
      { page: 2, per_page: 100 },
    ]);
  });
});

describe.skipIf(!isChild)("release asset storage (#479)", () => {
  const withAssets = (release: Record<string, unknown>, sizes: number[]) => ({
    ...release,
    assets: sizes.map((size, index) => ({ id: index + 1, name: `file-${index}`, size })),
  });

  it("records the assets left on the destination after retention", async () => {
    fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [
        withAssets(destinationRelease("v1.9.0-beta", 11, true), [100, 50]),
        withAssets(destinationRelease("v1.8.0", 12, false), [1000]),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseType: "stable" });

    expect(storageRecords).toEqual([{ repositoryId: "repo-1", summary: { count: 1, bytes: 1000 } }]);
  });

  it("keeps counting a release whose delete failed", async () => {
    fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [
        withAssets(destinationRelease("v1.9.0-beta", 11, true), [100, 50]),
        withAssets(destinationRelease("v1.8.0", 12, false), [1000]),
      ],
      failDeleteIds: [11],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseType: "stable" });

    expect(storageRecords).toEqual([{ repositoryId: "repo-1", summary: { count: 3, bytes: 1150 } }]);
  });

  it("lists past the first page when the destination pages below what was asked", async () => {
    // 35 releases, served 30 a page: the old per_page=100 loop stopped at 30.
    const listed = Array.from({ length: 35 }, (_, i) =>
      withAssets(destinationRelease(`v1.${i}.0`, 100 + i, false), [10])
    );
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: listed,
      destinationPageCap: 30,
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 50 });

    expect(storageRecords).toEqual([{ repositoryId: "repo-1", summary: { count: 35, bytes: 350 } }]);
    expect(world.requests.filter((r) => r.url.startsWith(`${DEST_API}/releases?`))).toHaveLength(2);
  });

  it("enforces the release limit across every page", async () => {
    const listed = Array.from({ length: 35 }, (_, i) =>
      withAssets(destinationRelease(`v1.${i}.0`, 100 + i, false), [10])
    );
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: listed,
      destinationPageCap: 30,
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseLimit: 10 });

    // The old loop saw 30 of the 35 and deleted 20, leaving 15.
    expect(world.requests.filter((r) => r.method === "DELETE")).toHaveLength(25);
  });

  it("records nothing when the listing fails", async () => {
    fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationListingFails: true,
    });

    await mirrorFromGitea(giteaConnection("source-token"));

    expect(storageRecords).toEqual([]);
  });

  it("makes no request of its own", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [withAssets(destinationRelease("v2.0.0", 12, false), [10])],
    });

    await mirrorFromGitea(giteaConnection("source-token"));

    const listings = world.requests.filter((r) => r.url.startsWith(`${DEST_API}/releases?`));
    expect(listings).toHaveLength(1);
    expect(storageRecords).toEqual([{ repositoryId: "repo-1", summary: { count: 1, bytes: 10 } }]);
  });
});

describe.skipIf(!isChild)("all releases removed warning", () => {
  it("warns when the filters leave the destination with no releases", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.1.0-beta.1", { prerelease: true })],
      destinationReleases: [
        destinationRelease("v2.0.0-beta", 21, true),
        destinationRelease("v1.9.0-beta", 22, true),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseType: "stable" });

    expect(world.deletes()).toHaveLength(2);
    expect(removalNotices).toEqual([
      {
        userId: "user-1",
        repositoryName: DEST_REPO,
        destination: `${DEST_OWNER}/${DEST_REPO}`,
        removedCount: 2,
      },
    ]);
    expect(activityJobs).toHaveLength(1);
    expect(activityJobs[0]).toMatchObject({
      status: "warning",
      message: `All releases removed from ${DEST_OWNER}/${DEST_REPO}`,
      skipNotification: true,
      skipDuplicateEvent: true,
    });
  });

  it("stays quiet while at least one release survives the filters", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [
        destinationRelease("v2.0.0-beta", 21, true),
        destinationRelease("v1.9.0", 22, false),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), { releaseType: "stable" });

    expect(world.deletes().map((r) => r.url)).toEqual([`${DEST_API}/releases/21`]);
    expect(removalNotices).toHaveLength(0);
    expect(activityJobs).toHaveLength(0);
  });
});

describe.skipIf(!isChild)("release tag pattern filter", () => {
  it("skips the source releases an exclude pattern names", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v2.1.0-rc.1"),
        giteaRelease("v2.0.0"),
        giteaRelease("v1.0.0"),
      ],
    });

    // The upstream never flagged anything as a pre-release, which is exactly the
    // case the tag filter exists for.
    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseExcludeTags: ["*-rc.*"],
    });

    expect(world.createdTags()).toEqual(["v2.0.0", "v1.0.0"]);
  });

  it("mirrors only the tags an include pattern names", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0"), giteaRelease("v1.2.0"), giteaRelease("v1.0.0")],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseIncludeTags: ["v1.*"],
    });

    expect(world.createdTags()).toEqual(["v1.2.0", "v1.0.0"]);
  });

  it("lets exclude win when both lists name a tag", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0"), giteaRelease("v2.0.0-rc.1")],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseIncludeTags: ["v*"],
      releaseExcludeTags: ["*-rc.*"],
    });

    expect(world.createdTags()).toEqual(["v2.0.0"]);
  });

  it("matches case-insensitively", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("V2.0.0"), giteaRelease("v1.0.0")],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseIncludeTags: ["v2*"],
    });

    expect(world.createdTags()).toEqual(["V2.0.0"]);
  });

  it("treats a pattern in slashes as a regular expression", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v1.2.3-rc.1"),
        giteaRelease("v1.2.3"),
        giteaRelease("nightly-20260101"),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseIncludeTags: ["/^v\\d+\\.\\d+\\.\\d+$/"],
    });

    expect(world.createdTags()).toEqual(["v1.2.3"]);
  });

  it("widens the scan window for a tag filter alone", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("nightly-20260201"),
        giteaRelease("nightly-20260115"),
        giteaRelease("v2.0.0"),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseLimit: 1,
      releaseIncludeTags: ["v*"],
    });

    // A one-release scan would have found only nightlies and mirrored nothing;
    // the filter looks further back so "the newest one" is the newest match.
    expect(world.createdTags()).toEqual(["v2.0.0"]);
    const listing = world.requests.find((r) => r.url.startsWith(`${SOURCE_URL}/api/v1/`));
    expect(listing?.url).toContain("limit=50&page=1");
  });

  it("removes destination releases whose tag no longer matches", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0")],
      destinationReleases: [
        // No pre-release flag: a tag pattern needs only the tag name, so unlike
        // the type filter it can still clean these up.
        destinationRelease("v1.9.0-beta", 11, null),
        destinationRelease("v1.8.0", 12, null),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseExcludeTags: ["*-beta"],
    });

    expect(world.deletes().map((r) => r.url)).toEqual([`${DEST_API}/releases/11`]);
  });

  it("combines with the type filter and the count limit", async () => {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v3.0.0-rc.1", { prerelease: true }),
        giteaRelease("v2.9.0-beta.2"),
        giteaRelease("v2.0.0"),
        giteaRelease("v1.0.0"),
      ],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseLimit: 1,
      releaseType: "stable",
      releaseExcludeTags: ["*-beta*"],
    });

    expect(world.createdTags()).toEqual(["v2.0.0"]);
  });

  it("ignores a pattern that cannot compile instead of failing the run", async () => {
    const world = fakeWorld({
      sourceReleases: [giteaRelease("v2.0.0"), giteaRelease("v1.0.0")],
    });

    await mirrorFromGitea(giteaConnection("source-token"), {
      releaseExcludeTags: ["/v1(/"],
    });

    // The broken pattern is dropped, which leaves no filter at all rather than a
    // mirror run that throws.
    expect(world.createdTags()).toEqual(["v2.0.0", "v1.0.0"]);
    expect(world.deletes()).toHaveLength(0);
  });
});

describe.skipIf(!isChild)("mirrorGitHubReleasesToGitea keeps its own header and credentials", () => {
  function githubOctokit(releases: Array<Record<string, unknown>>) {
    return {
      rest: {
        repos: {
          listReleases: async ({ page }: { page: number }) => ({
            data: page === 1 ? releases : [],
          }),
        },
      },
    } as any;
  }

  function githubReleaseWithAsset(tag: string) {
    return {
      tag_name: tag,
      name: `Release ${tag}`,
      body: "",
      draft: false,
      prerelease: false,
      created_at: "2026-01-01T00:00:00Z",
      published_at: "2026-01-01T00:00:00Z",
      assets: [
        {
          name: `${tag}.bin`,
          size: 4,
          url: `https://api.github.com/repos/acme/demo/releases/assets/${tag}`,
          browser_download_url: `https://github.com/acme/demo/releases/download/${tag}/${tag}.bin`,
        },
      ],
    };
  }

  function mirrorFromGitHub(releases: Array<Record<string, unknown>>, isPrivate: boolean) {
    return mirrorGitHubReleasesToGitea({
      config,
      octokit: githubOctokit(releases),
      repository: { ...repository, isPrivate } as Repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      releaseLimit: 10,
      releaseAssetLimit: null,
    });
  }

  it("downloads a public repository's assets from the browser URL, which spends no API budget", async () => {
    const world = fakeWorld({ sourceReleases: [], destinationTags: ["v1.0.0"] });

    await mirrorFromGitHub([githubReleaseWithAsset("v1.0.0")], false);

    expect(world.downloads().map((r) => r.url)).toEqual([
      "https://github.com/acme/demo/releases/download/v1.0.0/v1.0.0.bin",
    ]);
  });

  it("downloads a private repository's assets from the REST asset URL", async () => {
    const world = fakeWorld({ sourceReleases: [], destinationTags: ["v1.0.0"] });

    await mirrorFromGitHub([githubReleaseWithAsset("v1.0.0")], true);

    expect(world.downloads().map((r) => r.url)).toEqual([
      "https://api.github.com/repos/acme/demo/releases/assets/v1.0.0",
    ]);
    expect(world.uploads()).toHaveLength(1);
  });

  it("stops the whole pass when the rate limit gate closes, instead of trying the next release", async () => {
    const world = fakeWorld({ sourceReleases: [], destinationTags: ["v2.0.0", "v1.0.0"] });
    markRateLimited(rateLimitGateKey("user-1"), Date.now() + 3_600_000);

    try {
      await expect(
        mirrorFromGitHub([githubReleaseWithAsset("v2.0.0"), githubReleaseWithAsset("v1.0.0")], true)
      ).rejects.toThrow("rate limit");
    } finally {
      clearAllRateLimits();
    }

    expect(world.downloads()).toHaveLength(0);
    expect(world.createdTags()).toEqual(["v2.0.0"]);
  });

  it("writes the GitHub header byte for byte and downloads with the GitHub token", async () => {
    const world = fakeWorld({
      sourceReleases: [],
      destinationTags: ["v1.0.0"],
    });

    await mirrorGitHubReleasesToGitea({
      config,
      octokit: githubOctokit([
        {
          tag_name: "v1.0.0",
          name: "Release v1.0.0",
          body: "notes for v1.0.0",
          draft: false,
          prerelease: false,
          created_at: "2026-01-01T00:00:00Z",
          published_at: "2026-01-01T00:00:00Z",
          assets: [
            {
              name: "firmware.bin",
              size: 4,
              browser_download_url:
                "https://github.com/acme/demo/releases/download/v1.0.0/firmware.bin",
            },
          ],
        },
      ]),
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      releaseLimit: 10,
      releaseAssetLimit: null,
    });

    const [create] = world.creates();
    expect(JSON.parse(create.body!).body).toBe(
      "> 📅 **Originally published on GitHub:** Thu, 01 Jan 2026 00:00:00 GMT\n\nnotes for v1.0.0"
    );

    const [download] = world.downloads();
    expect(download.authorization).toBe("token github-token");
  });

  it("sends no Authorization header when the GitHub source has no token", async () => {
    const world = fakeWorld({ sourceReleases: [], destinationTags: ["v1.0.0"] });

    await mirrorGitHubReleasesToGitea({
      config: {
        ...config,
        githubConfig: { ...(config.githubConfig as any), token: "" },
      } as Partial<Config>,
      octokit: githubOctokit([
        {
          tag_name: "v1.0.0",
          name: "Release v1.0.0",
          body: "",
          draft: false,
          prerelease: false,
          created_at: "2026-01-01T00:00:00Z",
          published_at: "2026-01-01T00:00:00Z",
          assets: [
            {
              name: "firmware.bin",
              size: 4,
              browser_download_url:
                "https://github.com/acme/demo/releases/download/v1.0.0/firmware.bin",
            },
          ],
        },
      ]),
      repository,
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      releaseLimit: 10,
      releaseAssetLimit: null,
    });

    const [download] = world.downloads();
    expect(download.authorization).toBeNull();
  });

  it("prefers the repository's own GitHub source token over the primary config token", async () => {
    const world = fakeWorld({ sourceReleases: [], destinationTags: ["v1.0.0"] });

    await mirrorGitHubReleasesToGitea({
      config,
      octokit: githubOctokit([
        {
          tag_name: "v1.0.0",
          name: "Release v1.0.0",
          body: "",
          draft: false,
          prerelease: false,
          created_at: "2026-01-01T00:00:00Z",
          published_at: "2026-01-01T00:00:00Z",
          assets: [
            {
              name: "firmware.bin",
              size: 4,
              browser_download_url:
                "https://github.com/acme/demo/releases/download/v1.0.0/firmware.bin",
            },
          ],
        },
      ]),
      repository,
      sourceToken: "ghes-token",
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      releaseLimit: 10,
      releaseAssetLimit: null,
    });

    const [download] = world.downloads();
    expect(download.authorization).toBe("token ghes-token");
  });
});

describe.skipIf(!isChild)("pruning release assets past the asset limit", () => {
  function configWithPruning(prune: boolean) {
    return {
      ...config,
      giteaConfig: {
        ...(config as any).giteaConfig,
        pruneOldReleaseAssets: prune,
      },
    } as unknown as Partial<Config>;
  }

  const destinationReleases = [
    {
      id: 1,
      tag_name: "v3.0.0",
      created_at: "2026-03-01T00:00:00Z",
      prerelease: false,
      assets: [{ id: 11, name: "new.bin", size: 7 }],
    },
    {
      id: 2,
      tag_name: "v2.0.0",
      created_at: "2026-02-01T00:00:00Z",
      prerelease: false,
      assets: [{ id: 21, name: "old.bin", size: 5 }],
    },
    {
      id: 3,
      tag_name: "v1.0.0",
      created_at: "2026-01-01T00:00:00Z",
      prerelease: false,
      assets: [{ id: 31, name: "older.bin", size: 3 }],
    },
  ];

  /** Three releases on both sides; an asset limit of 1 covers only v3.0.0. */
  function run(prune: boolean, extra: Partial<DestinationOptions> = {}) {
    const world = fakeWorld({
      sourceReleases: [
        giteaRelease("v3.0.0"),
        giteaRelease("v2.0.0"),
        giteaRelease("v1.0.0"),
      ],
      destinationReleases,
      destinationAssets: {
        "1": [{ id: 11, name: "new.bin", size: 7 }],
        "2": [{ id: 21, name: "old.bin", size: 5 }],
        "3": [{ id: 31, name: "older.bin", size: 3 }],
      },
      ...extra,
    });

    return mirrorGiteaSourceReleasesToGitea({
      config: configWithPruning(prune),
      repository,
      connection: giteaConnection("source-token"),
      giteaOwner: DEST_OWNER,
      giteaRepoName: DEST_REPO,
      releaseLimit: 3,
      releaseAssetLimit: 1,
    }).then(() => world);
  }

  it("keeps attachments a looser limit uploaded before", async () => {
    const world = await run(false);

    expect(world.assetListings()).toHaveLength(0);
    expect(world.assetDeletes()).toHaveLength(0);
    expect(storageRecords.at(-1)?.summary).toEqual({ count: 3, bytes: 15 });
  });

  it("deletes the attachments of releases past the asset limit when enabled", async () => {
    const world = await run(true);

    expect(world.assetDeletes().map((r) => r.url)).toEqual([
      `${DEST_API}/releases/2/assets/21`,
      `${DEST_API}/releases/3/assets/31`,
    ]);
    // The newest release stays inside the limit and keeps its file.
    expect(world.assetListings().map((r) => r.url)).toEqual([
      `${DEST_API}/releases/2/assets`,
      `${DEST_API}/releases/3/assets`,
    ]);
    // The storage summary follows the deletions instead of reporting the old total.
    expect(storageRecords.at(-1)?.summary).toEqual({ count: 1, bytes: 7 });
  });

  it("skips releases the listing shows without attachments", async () => {
    // v1.0.0 was pruned on an earlier sync: it is not listed or deleted again.
    const world = await run(true, {
      destinationReleases: destinationReleases.map((release) =>
        release.id === 3 ? { ...release, assets: [] } : release
      ),
      destinationAssets: {
        "1": [{ id: 11, name: "new.bin", size: 7 }],
        "2": [{ id: 21, name: "old.bin", size: 5 }],
        "3": [],
      },
    });

    expect(world.assetListings().map((r) => r.url)).toEqual([
      `${DEST_API}/releases/2/assets`,
    ]);
    expect(world.assetDeletes().map((r) => r.url)).toEqual([
      `${DEST_API}/releases/2/assets/21`,
    ]);
    expect(storageRecords.at(-1)?.summary).toEqual({ count: 1, bytes: 7 });
  });

  it("deletes nothing when a release's attachments cannot be listed", async () => {
    const world = await run(true, { failAssetListingFor: [2, 3] });

    expect(world.assetDeletes()).toHaveLength(0);
    expect(storageRecords.at(-1)?.summary).toEqual({ count: 3, bytes: 15 });
  });
});
