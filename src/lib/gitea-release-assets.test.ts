/**
 * Behavioral tests for release asset reconciliation, regression for #417.
 *
 * Reported symptom: release assets mirrored to Gitea/Forgejo appear twice (some
 * three times, one five times), with identical sizes and identical creation
 * times, so the copies came from passes that overlapped inside one run.
 *
 * Cause: reconcileReleaseAssets listed the attachments a release already had,
 * then downloaded and uploaded everything it judged missing. The destination
 * has no name-collision check on attachment upload (Gitea's and Forgejo's
 * CreateReleaseAttachment appends a row for every POST), so two overlapping
 * passes both read "missing" and both uploaded. A failed listing was read as
 * "the release has no assets", and a failed delete was followed by the upload
 * anyway; both added copies too.
 *
 * The fake destination below models the real behavior that makes duplicates
 * possible: every POST appends another attachment with the same name.
 *
 * No module mocks here on purpose (bun's mock.module is process-wide and leaks
 * into other test files): reconcileReleaseAssets takes the fetch it should use.
 */

import { describe, expect, it } from "bun:test";
import { reconcileReleaseAssets, buildReleaseTargetLockKey } from "@/lib/gitea";
import { withKeyedLock } from "@/lib/utils/keyed-mutex";
import type { Config } from "@/types/config";

const GITEA_URL = "https://gitea.example.com";
const OWNER = "mirror-owner";
const REPO = "demo";
const RELEASE_ID = 77;
const ASSETS_URL = `${GITEA_URL}/api/v1/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets`;

const config = {
  giteaConfig: { url: GITEA_URL, token: "gitea-token", defaultOwner: OWNER },
} as unknown as Partial<Config>;

const decryptedConfig = {
  giteaConfig: { url: GITEA_URL, token: "gitea-token", defaultOwner: OWNER },
  githubConfig: { token: "github-token", username: "upstream" },
} as unknown as Config;

type Attachment = { id: number; name: string; size: number };

interface FakeDestinationOptions {
  /** Attachments the release already carries. */
  existing?: Attachment[];
  /** Status for the "list attachments" GET. */
  listStatus?: number;
  /** Status for attachment deletes. */
  deleteStatus?: number;
  /** Status for attachment uploads. */
  uploadStatus?: number;
}

/** A GitHub asset plus the destination-side size the fake records on upload. */
function githubAsset(name: string, size: number) {
  return {
    name,
    size,
    browser_download_url: `https://github.com/upstream/demo/releases/download/v1.0.0/${name}`,
  };
}

function createFakeDestination(options: FakeDestinationOptions = {}) {
  const attachments: Attachment[] = [...(options.existing ?? [])];
  const requests: Array<{ method: string; url: string }> = [];
  let nextId = 500;

  const fetchImpl = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    requests.push({ method, url });

    // Every request yields the event loop, so a second pass running at the
    // same time gets to interleave, which is what created the duplicates.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Downloading the asset from the source host.
    if (url.startsWith("https://github.com/")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }

    if (method === "GET" && url === ASSETS_URL) {
      const status = options.listStatus ?? 200;
      if (status !== 200) {
        return new Response("boom", { status, statusText: "Internal Server Error" });
      }
      return new Response(JSON.stringify(attachments), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "DELETE" && url.startsWith(`${ASSETS_URL}/`)) {
      const status = options.deleteStatus ?? 204;
      if (status >= 400) {
        return new Response("nope", { status, statusText: "Internal Server Error" });
      }
      const id = Number(url.slice(`${ASSETS_URL}/`.length));
      const index = attachments.findIndex((a) => a.id === id);
      if (index >= 0) attachments.splice(index, 1);
      return new Response(null, { status });
    }

    if (method === "POST" && url.startsWith(`${ASSETS_URL}?`)) {
      const status = options.uploadStatus ?? 201;
      if (status >= 400) {
        return new Response("rejected", { status, statusText: "Bad Request" });
      }
      const name = decodeURIComponent(new URL(url).searchParams.get("name") ?? "");
      // The real destination does no name-collision check: every POST appends
      // another attachment, even when one with that name is already there.
      attachments.push({ id: nextId++, name, size: uploadSizes.get(name) ?? 4 });
      return new Response(JSON.stringify({ id: nextId }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  const uploadSizes = new Map<string, number>();

  return {
    fetchImpl,
    attachments,
    requests,
    /** Size the destination records for an uploaded asset (defaults to 4). */
    setUploadedSize(name: string, size: number) {
      uploadSizes.set(name, size);
    },
    posts: () => requests.filter((r) => r.method === "POST"),
    deletes: () => requests.filter((r) => r.method === "DELETE"),
  };
}

function reconcile(
  fetchImpl: typeof fetch,
  githubAssets: Array<{ name: string; size: number; browser_download_url: string }>
) {
  return reconcileReleaseAssets({
    config,
    decryptedConfig,
    repoOwner: OWNER,
    repoName: REPO,
    giteaReleaseId: RELEASE_ID,
    githubAssets,
    tagName: "v1.0.0",
    fetchImpl,
  });
}

describe("reconcileReleaseAssets", () => {
  it("uploads every asset once on a release that has none", async () => {
    const destination = createFakeDestination();
    destination.setUploadedSize("base.zip", 4);
    destination.setUploadedSize("extras.zip", 4);

    const result = await reconcile(destination.fetchImpl, [
      githubAsset("base.zip", 4),
      githubAsset("extras.zip", 4),
    ]);

    expect(result).toEqual({ uploaded: 2, failed: 0, skipped: 0 });
    expect(destination.posts()).toHaveLength(2);
    expect(destination.attachments.map((a) => a.name).sort()).toEqual([
      "base.zip",
      "extras.zip",
    ]);
  });

  it("two overlapping passes under the destination lock upload each asset once (#417)", async () => {
    const destination = createFakeDestination();
    destination.setUploadedSize("base.zip", 4);
    const assets = [githubAsset("base.zip", 4)];
    const key = buildReleaseTargetLockKey(GITEA_URL, OWNER, REPO);

    // Two runs of the same repository starting at the same time: the scheduler
    // and a manual sync, or two repository rows pointing at one destination.
    const [first, second] = await Promise.all([
      withKeyedLock(key, () => reconcile(destination.fetchImpl, assets)),
      withKeyedLock(key, () => reconcile(destination.fetchImpl, assets)),
    ]);

    expect(destination.posts()).toHaveLength(1);
    expect(destination.attachments).toHaveLength(1);
    expect(first).toEqual({ uploaded: 1, failed: 0, skipped: 0 });
    // The second pass finds the asset already there and leaves it alone.
    expect(second).toEqual({ uploaded: 0, failed: 0, skipped: 1 });
  });

  it("without the lock, two overlapping passes are what duplicated the asset", async () => {
    const destination = createFakeDestination();
    destination.setUploadedSize("base.zip", 4);
    const assets = [githubAsset("base.zip", 4)];

    await Promise.all([
      reconcile(destination.fetchImpl, assets),
      reconcile(destination.fetchImpl, assets),
    ]);

    // The fake reproduces the reported failure: identical name, identical size,
    // two attachments. This is the state the lock prevents.
    expect(destination.posts()).toHaveLength(2);
    expect(destination.attachments).toHaveLength(2);
  });

  it("uploads nothing when the existing attachments cannot be listed", async () => {
    const destination = createFakeDestination({ listStatus: 500 });

    const result = await reconcile(destination.fetchImpl, [
      githubAsset("base.zip", 4),
      githubAsset("extras.zip", 4),
    ]);

    // Fail closed: a failed listing used to read as "the release has no
    // assets", so the pass re-uploaded everything the release already had.
    expect(destination.posts()).toHaveLength(0);
    expect(destination.deletes()).toHaveLength(0);
    expect(result).toEqual({ uploaded: 0, failed: 2, skipped: 0 });
  });

  it("does not upload an asset whose stale copy could not be deleted", async () => {
    const destination = createFakeDestination({
      existing: [{ id: 11, name: "firmware.bin", size: 1024 }],
      deleteStatus: 500,
    });

    const result = await reconcile(destination.fetchImpl, [
      githubAsset("firmware.bin", 2048),
    ]);

    expect(destination.deletes()).toHaveLength(1);
    // Uploading after the failed delete would leave two copies.
    expect(destination.posts()).toHaveLength(0);
    expect(destination.attachments).toHaveLength(1);
    expect(result).toEqual({ uploaded: 0, failed: 1, skipped: 0 });
  });

  it("cleans up an existing duplicate without uploading anything", async () => {
    const destination = createFakeDestination({
      existing: [
        { id: 11, name: "base.zip", size: 4 },
        { id: 12, name: "base.zip", size: 4 },
      ],
    });

    const result = await reconcile(destination.fetchImpl, [githubAsset("base.zip", 4)]);

    expect(destination.deletes()).toHaveLength(1);
    expect(destination.deletes()[0].url).toBe(`${ASSETS_URL}/12`);
    expect(destination.posts()).toHaveLength(0);
    expect(destination.attachments).toEqual([{ id: 11, name: "base.zip", size: 4 }]);
    expect(result).toEqual({ uploaded: 0, failed: 0, skipped: 1 });
  });

  it("replaces stale copies: deletes both, then uploads once", async () => {
    const destination = createFakeDestination({
      existing: [
        { id: 11, name: "firmware.bin", size: 1024 },
        { id: 12, name: "firmware.bin", size: 999 },
      ],
    });
    destination.setUploadedSize("firmware.bin", 2048);

    const result = await reconcile(destination.fetchImpl, [
      githubAsset("firmware.bin", 2048),
    ]);

    expect(destination.deletes().map((r) => r.url)).toEqual([
      `${ASSETS_URL}/11`,
      `${ASSETS_URL}/12`,
    ]);
    expect(destination.posts()).toHaveLength(1);
    expect(destination.attachments).toHaveLength(1);
    expect(destination.attachments[0].size).toBe(2048);
    expect(result).toEqual({ uploaded: 1, failed: 0, skipped: 0 });
    // Deletes come before the upload, never after it.
    const kinds = destination.requests.map((r) => r.method);
    expect(kinds.indexOf("POST")).toBeGreaterThan(kinds.lastIndexOf("DELETE"));
  });

  it("leaves attachments alone that the release does not have upstream", async () => {
    const destination = createFakeDestination({
      existing: [{ id: 11, name: "from-an-older-sync.zip", size: 4 }],
    });
    destination.setUploadedSize("base.zip", 4);

    const result = await reconcile(destination.fetchImpl, [githubAsset("base.zip", 4)]);

    expect(destination.deletes()).toHaveLength(0);
    expect(destination.posts()).toHaveLength(1);
    expect(result).toEqual({ uploaded: 1, failed: 0, skipped: 0 });
  });

  it("does nothing at all for a release with no assets", async () => {
    const destination = createFakeDestination();

    const result = await reconcile(destination.fetchImpl, []);

    expect(destination.requests).toHaveLength(0);
    expect(result).toEqual({ uploaded: 0, failed: 0, skipped: 0 });
  });
});

describe("buildReleaseTargetLockKey", () => {
  it("keys on destination, owner and repository, case-insensitively", () => {
    expect(buildReleaseTargetLockKey("https://gitea.example.com/", "Owner", "Repo")).toBe(
      buildReleaseTargetLockKey("https://GITEA.example.com", "owner", "repo")
    );
  });

  it("separates different repositories on the same destination", () => {
    expect(buildReleaseTargetLockKey(GITEA_URL, OWNER, "one")).not.toBe(
      buildReleaseTargetLockKey(GITEA_URL, OWNER, "two")
    );
  });
});
