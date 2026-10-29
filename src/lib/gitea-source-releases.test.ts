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
      return json(options.sourceReleases);
    }

    // Downloading an asset from the source host.
    if (url.startsWith(`${SOURCE_URL}/attachments/`) || url.startsWith("https://github.com/")) {
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
      return json([]);
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
    downloads: () =>
      requests.filter(
        (r) => r.url.startsWith(`${SOURCE_URL}/attachments/`) || r.url.startsWith("https://github.com/")
      ),
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
