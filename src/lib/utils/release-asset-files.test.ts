import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dataDir: string;
let savedUrl: string | undefined;
beforeEach(async () => {
  savedUrl = process.env.DATABASE_URL;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "release-asset-files-test-"));
  process.env.DATABASE_URL = `sqlite://${path.join(dataDir, "gitea-mirror.db")}`;
});
afterEach(async () => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
  await rm(dataDir, { recursive: true, force: true });
});

describe("release asset files", () => {
  it("live next to the database, not in the system temp directory", async () => {
    const { createReleaseAssetDir, releaseAssetFilesRoot } = await import("./release-asset-files");

    const dir = await createReleaseAssetDir();

    expect(releaseAssetFilesRoot()).toBe(path.join(dataDir, "tmp", "release-assets"));
    expect(path.dirname(dir)).toBe(releaseAssetFilesRoot());
  });

  it("clear out what a crash left behind a day ago, and nothing newer", async () => {
    const { createReleaseAssetDir } = await import("./release-asset-files");
    const root = path.join(dataDir, "tmp", "release-assets");
    await mkdir(path.join(root, "asset-old"), { recursive: true });
    await mkdir(path.join(root, "asset-recent"), { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(path.join(root, "asset-old"), twoDaysAgo, twoDaysAgo);

    const fresh = await createReleaseAssetDir();

    expect((await readdir(root)).sort()).toEqual(["asset-recent", path.basename(fresh)].sort());
  });
});
