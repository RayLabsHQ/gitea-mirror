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

import { afterEach, describe, expect, it, test } from "bun:test";
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

    // The retention pass lists everything the destination has.
    if (method === "GET" && url.startsWith(`${DEST_API}/releases?`)) {
      return json([]);
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return {
    requests,
    creates: () => requests.filter((r) => r.method === "POST" && r.url === `${DEST_API}/releases`),
    patches: () => requests.filter((r) => r.method === "PATCH"),
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

function mirrorFromGitea(connection: SourceConnection) {
  return mirrorGiteaSourceReleasesToGitea({
    config,
    repository,
    connection,
    giteaOwner: DEST_OWNER,
    giteaRepoName: DEST_REPO,
    releaseLimit: 10,
    releaseAssetLimit: null,
  });
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
