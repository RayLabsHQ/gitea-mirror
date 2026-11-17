/**
 * Where a release asset waits between its download and its upload (#523).
 *
 * In the data directory next to the SQLite file, like the push engine's clones,
 * and not in the system temp directory: on Debian 13, which the Proxmox LXC
 * install runs on, /tmp is a tmpfs by default, so a file there sits in memory
 * again.
 */
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resolveDbPath } from "@/lib/db/path";

export function releaseAssetFilesRoot(): string {
  return path.join(path.dirname(resolveDbPath()), "tmp", "release-assets");
}

/** Older than any download could run, so nobody is still using it. */
const LEFT_BEHIND_AFTER_MS = 24 * 60 * 60 * 1000;
let sweptRoot: string | undefined;

/** A new directory for one asset. The caller removes it when done. */
export async function createReleaseAssetDir(): Promise<string> {
  const root = releaseAssetFilesRoot();
  await mkdir(root, { recursive: true });
  if (sweptRoot !== root) {
    sweptRoot = root;
    await removeLeftBehind(root);
  }
  return mkdtemp(path.join(root, "asset-"));
}

/** Directories a crash or a restart mid-download left behind. */
async function removeLeftBehind(root: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, name);
    const info = await stat(dir).catch(() => null);
    if (info && now - info.mtimeMs > LEFT_BEHIND_AFTER_MS) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
