/**
 * Unit tests for the Gitea/Forgejo source adapter's release listing (#440).
 *
 * Release mirroring used to be GitHub only. Gitea and Forgejo expose
 * `GET /repos/{owner}/{repo}/releases` with the same limit/page pagination and
 * x-total-count header as their other list endpoints, which is what lets a
 * Codeberg or self hosted repository mirror its releases.
 *
 * The global fetch is swapped rather than the module, because bun's
 * mock.module is process-wide and leaks into other test files.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { GiteaSourceProvider } from "./gitea-source";
import type { SourceConnection } from "./types";

const SOURCE_URL = "https://codeberg.org";
const RELEASES_PATH = `${SOURCE_URL}/api/v1/repos/acme/demo/releases`;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function connection(token = "source-token"): SourceConnection {
  return {
    provider: "gitea",
    url: SOURCE_URL,
    username: "acme",
    token,
  };
}

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    id: Number(tag.replace(/\D/g, "")) || 1,
    tag_name: tag,
    name: `Release ${tag}`,
    body: `notes for ${tag}`,
    draft: false,
    prerelease: false,
    created_at: "2026-01-01T00:00:00Z",
    published_at: "2026-01-02T00:00:00Z",
    assets: [],
    ...extra,
  };
}

interface FakeOptions {
  /** Pages returned in order, newest first overall. */
  pages: Array<Array<Record<string, unknown>>>;
  /** Value for the x-total-count header, or null to omit it. */
  totalCount?: number | null;
}

function fakeSource(options: FakeOptions) {
  const requests: Array<{ url: string; authorization: string | null }> = [];

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    const headers = new Headers(init?.headers ?? {});
    requests.push({ url, authorization: headers.get("authorization") });

    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const body = options.pages[page - 1] ?? [];
    const responseHeaders: Record<string, string> = {
      "content-type": "application/json",
    };
    if (options.totalCount !== null && options.totalCount !== undefined) {
      responseHeaders["x-total-count"] = String(options.totalCount);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: responseHeaders,
    });
  }) as unknown as typeof fetch;

  return requests;
}

describe("GiteaSourceProvider.listReleases", () => {
  it("asks for the newest releases with limit and page", async () => {
    const requests = fakeSource({ pages: [[release("v1.0.0"), release("v0.9.0")]], totalCount: 2 });

    const releases = await new GiteaSourceProvider(connection()).listReleases("acme", "demo", 10);

    expect(releases.map((r) => r.tag_name)).toEqual(["v1.0.0", "v0.9.0"]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${RELEASES_PATH}?limit=10&page=1`);
  });

  it("caps the page size at the requested limit and never returns more", async () => {
    const requests = fakeSource({
      pages: [[release("v3"), release("v2"), release("v1")]],
      totalCount: 99,
    });

    const releases = await new GiteaSourceProvider(connection()).listReleases("acme", "demo", 2);

    expect(requests[0].url).toBe(`${RELEASES_PATH}?limit=2&page=1`);
    // The instance may over-serve; the limit still wins.
    expect(releases.map((r) => r.tag_name)).toEqual(["v3", "v2"]);
    expect(requests).toHaveLength(1);
  });

  it("pages until the limit is reached, capping the page size at 50", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => release(`v${100 - i}`));
    const secondPage = [release("v50"), release("v49")];
    const requests = fakeSource({ pages: [firstPage, secondPage], totalCount: 120 });

    const releases = await new GiteaSourceProvider(connection()).listReleases("acme", "demo", 52);

    expect(releases).toHaveLength(52);
    expect(requests.map((r) => r.url)).toEqual([
      `${RELEASES_PATH}?limit=50&page=1`,
      `${RELEASES_PATH}?limit=2&page=2`,
    ]);
  });

  it("stops at x-total-count instead of asking for a page that cannot exist", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => release(`v${100 - i}`));
    const requests = fakeSource({ pages: [firstPage, []], totalCount: 50 });

    const releases = await new GiteaSourceProvider(connection()).listReleases("acme", "demo", 100);

    expect(releases).toHaveLength(50);
    expect(requests).toHaveLength(1);
  });

  it("falls back to a short page when the instance omits x-total-count", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => release(`v${100 - i}`));
    const requests = fakeSource({ pages: [firstPage, [release("v50")]], totalCount: null });

    const releases = await new GiteaSourceProvider(connection()).listReleases("acme", "demo", 100);

    expect(releases).toHaveLength(51);
    expect(requests).toHaveLength(2);
  });

  it("sends the source token when the connection has one", async () => {
    const requests = fakeSource({ pages: [[release("v1")]], totalCount: 1 });

    await new GiteaSourceProvider(connection("source-token")).listReleases("acme", "demo", 5);

    expect(requests[0].authorization).toBe("token source-token");
  });

  it("sends no Authorization header for a tokenless public source", async () => {
    const requests = fakeSource({ pages: [[release("v1")]], totalCount: 1 });

    await new GiteaSourceProvider(connection("")).listReleases("acme", "demo", 5);

    expect(requests[0].authorization).toBeNull();
  });

  it("normalizes assets and drops entries with nothing to download", async () => {
    fakeSource({
      pages: [
        [
          release("v1.0.0", {
            assets: [
              {
                id: 1,
                name: "firmware.bin",
                size: 2048,
                browser_download_url: `${SOURCE_URL}/attachments/abc`,
              },
              { id: 2, name: "no-url.bin", size: 10 },
              { id: 3, size: 10, browser_download_url: `${SOURCE_URL}/attachments/def` },
            ],
          }),
        ],
      ],
      totalCount: 1,
    });

    const [mirrored] = await new GiteaSourceProvider(connection()).listReleases(
      "acme",
      "demo",
      5
    );

    expect(mirrored.assets).toEqual([
      {
        name: "firmware.bin",
        size: 2048,
        browser_download_url: `${SOURCE_URL}/attachments/abc`,
      },
    ]);
    expect(mirrored.name).toBe("Release v1.0.0");
    expect(mirrored.body).toBe("notes for v1.0.0");
    expect(mirrored.published_at).toBe("2026-01-02T00:00:00Z");
  });

  it("drops releases without a tag, which cannot be mirrored", async () => {
    fakeSource({ pages: [[release("v1"), { ...release("x"), tag_name: "" }]], totalCount: 2 });

    const releases = await new GiteaSourceProvider(connection()).listReleases("acme", "demo", 5);

    expect(releases.map((r) => r.tag_name)).toEqual(["v1"]);
  });
});
