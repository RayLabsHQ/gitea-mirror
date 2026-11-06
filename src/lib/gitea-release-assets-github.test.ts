/**
 * Release assets of a private GitHub repository.
 *
 * Reported symptom: for a private GitHub repository, releases, issues and pull
 * requests mirrored fine, but every release asset failed with
 * "Failed to download asset …: 404 Not Found", with a classic PAT and with a
 * fine-grained one alike.
 *
 * Cause: the asset was downloaded from browser_download_url
 * (github.com/<owner>/<repo>/releases/download/…). For a private repository
 * that URL only accepts a logged-in browser session and answers 404 to API
 * tokens. The REST asset URL (`asset.url`) with Accept: application/octet-stream
 * answers 302 to a pre-signed storage URL (or, rarely, 200 with the content);
 * the storage host must be called without the token.
 *
 * The fake hosts below behave that way. No module mocks (see
 * gitea-release-assets.test.ts): reconcileReleaseAssets takes the fetch to use.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { reconcileReleaseAssets } from "@/lib/gitea";
import {
  RateLimitPausedError,
  clearAllRateLimits,
  markRateLimited,
  rateLimitGateKey,
  rateLimitedUntil,
} from "@/lib/rate-limit-gate";
import type { Config } from "@/types/config";

const GITEA_URL = "https://gitea.example.com";
const OWNER = "mirror-owner";
const REPO = "private-demo";
const RELEASE_ID = 7;
const ASSETS_URL = `${GITEA_URL}/api/v1/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets`;
const BROWSER_DOWNLOAD = "https://github.com/upstream/private-demo/releases/download/v1.0.0/";
const API_ASSET = "https://api.github.com/repos/upstream/private-demo/releases/assets/";
const STORAGE = "https://release-assets.githubusercontent.com/";
const OTHER_SOURCE = "https://forgejo.example.com/attachments/";
const GITHUB_TOKEN = "github-token";
const CONTENT = new Uint8Array([1, 2, 3, 4]);

const config = {
  giteaConfig: { url: GITEA_URL, token: "gitea-token", defaultOwner: OWNER },
} as unknown as Partial<Config>;

const decryptedConfig = {
  giteaConfig: { url: GITEA_URL, token: "gitea-token", defaultOwner: OWNER },
  githubConfig: { token: GITHUB_TOKEN, username: "upstream" },
} as unknown as Config;

type SourceAsset = { name: string; size: number; browser_download_url: string; api_url?: string };

/** An asset of a private GitHub repository, as the GitHub release listing maps it. */
function privateGitHubAsset(id: number, name: string): SourceAsset {
  return {
    name,
    size: CONTENT.length,
    browser_download_url: `${BROWSER_DOWNLOAD}${name}`,
    api_url: `${API_ASSET}${id}`,
  };
}

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | null;
  redirect?: string;
}

function createFakeHosts(
  options: {
    apiAnswersWithContent?: boolean;
    /** The asset API refuses every download with this status and these headers. */
    apiRefusal?: { status: number; headers?: Record<string, string> };
  } = {}
) {
  const seen: SeenRequest[] = [];
  const uploads: Array<{ name: string; size: number }> = [];
  // Whether the asset API's answer was already aborted when its redirect was followed.
  const apiAbortedWhenFollowed: boolean[] = [];
  let lastApiSignal: AbortSignal | undefined;

  const fetchImpl = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    seen.push({ method, url, authorization, redirect: init?.redirect });

    // Private repository: the browser URL does not accept API tokens.
    if (url.startsWith(BROWSER_DOWNLOAD)) {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }

    if (url.startsWith(API_ASSET)) {
      lastApiSignal = init?.signal;
      if (authorization !== `token ${GITHUB_TOKEN}`) {
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      }
      if (options.apiRefusal) {
        return new Response("refused", options.apiRefusal);
      }
      if (headers.get("accept") !== "application/octet-stream") {
        throw new Error("asked the asset API for metadata instead of the file");
      }
      if (options.apiAnswersWithContent) {
        return new Response(CONTENT, { status: 200 });
      }
      if (init?.redirect !== "manual") {
        // A followed redirect would carry the token to the storage host.
        throw new Error("the asset API redirect must be followed by hand");
      }
      const id = url.slice(API_ASSET.length);
      return new Response(null, {
        status: 302,
        statusText: "Found",
        headers: { location: `${STORAGE}${id}?sig=signed` },
      });
    }

    // Pre-signed storage URL: a second credential is rejected.
    if (url.startsWith(STORAGE)) {
      apiAbortedWhenFollowed.push(Boolean(lastApiSignal?.aborted));
      if (authorization) {
        return new Response("Only one auth mechanism allowed", {
          status: 400,
          statusText: "Bad Request",
        });
      }
      return new Response(CONTENT, { status: 200 });
    }

    // A Gitea / Forgejo source: its attachment URL takes that instance's token.
    if (url.startsWith(OTHER_SOURCE)) {
      if (authorization !== "token source-token") {
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      }
      return new Response(CONTENT, { status: 200 });
    }

    if (method === "GET" && url === ASSETS_URL) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }

    if (method === "POST" && url.startsWith(`${ASSETS_URL}?`)) {
      const name = new URL(url).searchParams.get("name") ?? "";
      const attachment = (init?.body as FormData).get("attachment") as Blob;
      uploads.push({ name, size: attachment.size });
      return new Response(JSON.stringify({ id: uploads.length }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    seen,
    uploads,
    apiAbortedWhenFollowed,
    requestsTo: (prefix: string) => seen.filter((r) => r.url.startsWith(prefix)),
  };
}

function reconcile(
  fetchImpl: typeof fetch,
  sourceAssets: SourceAsset[],
  downloadAuthorization: string | null = `token ${GITHUB_TOKEN}`
) {
  return reconcileReleaseAssets({
    config,
    decryptedConfig,
    repoOwner: OWNER,
    repoName: REPO,
    giteaReleaseId: RELEASE_ID,
    sourceAssets,
    downloadAuthorization,
    tagName: "v1.0.0",
    fetchImpl,
  });
}

describe("reconcileReleaseAssets: private GitHub repository", () => {
  // The test config has no userId, so this is the key the downloads use.
  const gateKey = rateLimitGateKey(undefined);

  beforeEach(() => {
    clearAllRateLimits();
  });

  it("downloads through the REST asset URL and follows the redirect without the token", async () => {
    const hosts = createFakeHosts();

    const result = await reconcile(hosts.fetchImpl, [
      privateGitHubAsset(101, "app_linux.zip"),
      privateGitHubAsset(102, "app_windows.exe"),
    ]);

    expect(result).toEqual({ uploaded: 2, failed: 0, skipped: 0 });
    expect(hosts.uploads).toEqual([
      { name: "app_linux.zip", size: CONTENT.length },
      { name: "app_windows.exe", size: CONTENT.length },
    ]);
    // The browser URL is never tried: it can only answer 404 here.
    expect(hosts.requestsTo(BROWSER_DOWNLOAD)).toHaveLength(0);

    const apiRequests = hosts.requestsTo(API_ASSET);
    expect(apiRequests).toHaveLength(2);
    for (const request of apiRequests) {
      expect(request.authorization).toBe(`token ${GITHUB_TOKEN}`);
      expect(request.redirect).toBe("manual");
    }

    const storageRequests = hosts.requestsTo(STORAGE);
    expect(storageRequests.map((r) => r.url)).toEqual([
      `${STORAGE}101?sig=signed`,
      `${STORAGE}102?sig=signed`,
    ]);
    // Only the Location is used: the redirect's own request is closed first.
    expect(hosts.apiAbortedWhenFollowed).toEqual([true, true]);
    for (const request of storageRequests) {
      expect(request.authorization).toBeNull();
    }
  });

  it("uploads the content when the asset API answers 200 directly", async () => {
    const hosts = createFakeHosts({ apiAnswersWithContent: true });

    const result = await reconcile(hosts.fetchImpl, [privateGitHubAsset(101, "app_linux.zip")]);

    expect(result).toEqual({ uploaded: 1, failed: 0, skipped: 0 });
    expect(hosts.uploads).toEqual([{ name: "app_linux.zip", size: CONTENT.length }]);
    expect(hosts.requestsTo(STORAGE)).toHaveLength(0);
  });

  it("counts the asset as failed and uploads nothing when the token has no access", async () => {
    const hosts = createFakeHosts();

    const result = await reconcile(
      hosts.fetchImpl,
      [privateGitHubAsset(101, "app_linux.zip")],
      "token some-other-token"
    );

    expect(result).toEqual({ uploaded: 0, failed: 1, skipped: 0 });
    expect(hosts.uploads).toHaveLength(0);
    expect(hosts.requestsTo(STORAGE)).toHaveLength(0);
  });

  it("sends nothing while the rate limit gate is closed and stops the pass", async () => {
    const hosts = createFakeHosts();
    markRateLimited(gateKey, Date.now() + 3_600_000);

    await expect(
      reconcile(hosts.fetchImpl, [
        privateGitHubAsset(101, "app_linux.zip"),
        privateGitHubAsset(102, "app_windows.exe"),
      ])
    ).rejects.toBeInstanceOf(RateLimitPausedError);

    expect(hosts.requestsTo(API_ASSET)).toHaveLength(0);
    expect(hosts.uploads).toHaveLength(0);
  });

  it("closes the gate when GitHub refuses a download, so the next asset is not sent", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const hosts = createFakeHosts({
      apiRefusal: {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      },
    });

    await expect(
      reconcile(hosts.fetchImpl, [
        privateGitHubAsset(101, "app_linux.zip"),
        privateGitHubAsset(102, "app_windows.exe"),
      ])
    ).rejects.toBeInstanceOf(RateLimitPausedError);

    expect(hosts.requestsTo(API_ASSET)).toHaveLength(1);
    expect(rateLimitedUntil(gateKey)?.getTime()).toBe(reset * 1000);
  });

  it("treats a 403 without rate limit headers as one failed asset and leaves the gate open", async () => {
    const hosts = createFakeHosts({ apiRefusal: { status: 403 } });

    const result = await reconcile(hosts.fetchImpl, [
      privateGitHubAsset(101, "app_linux.zip"),
      privateGitHubAsset(102, "app_windows.exe"),
    ]);

    expect(result).toEqual({ uploaded: 0, failed: 2, skipped: 0 });
    expect(hosts.requestsTo(API_ASSET)).toHaveLength(2);
    expect(rateLimitedUntil(gateKey)).toBeNull();
  });

  it("does not hold a browser URL download behind a closed gate: it spends no API budget", async () => {
    const hosts = createFakeHosts();
    markRateLimited(gateKey, Date.now() + 3_600_000);

    const result = await reconcile(
      hosts.fetchImpl,
      [{ name: "tool.tar.gz", size: CONTENT.length, browser_download_url: `${OTHER_SOURCE}abc` }],
      "token source-token"
    );

    expect(result).toEqual({ uploaded: 1, failed: 0, skipped: 0 });
  });

  it("keeps using browser_download_url for assets without an api_url (Gitea / Forgejo sources)", async () => {
    const hosts = createFakeHosts();

    const result = await reconcile(
      hosts.fetchImpl,
      [
        {
          name: "tool.tar.gz",
          size: CONTENT.length,
          browser_download_url: `${OTHER_SOURCE}abc`,
        },
      ],
      "token source-token"
    );

    expect(result).toEqual({ uploaded: 1, failed: 0, skipped: 0 });
    expect(hosts.uploads).toEqual([{ name: "tool.tar.gz", size: CONTENT.length }]);
    const sourceRequests = hosts.requestsTo(OTHER_SOURCE);
    expect(sourceRequests).toHaveLength(1);
    expect(sourceRequests[0].authorization).toBe("token source-token");
  });
});
