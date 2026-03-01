import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Config } from "@/types/config";
import { createPreSyncBundleBackup } from "@/lib/repo-backup";

function createEmptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

describe("createPreSyncBundleBackup", () => {
  let originalSpawn: typeof Bun.spawn;
  let originalBackupDirEnv: string | undefined;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalBackupDirEnv = process.env.PRE_SYNC_BACKUP_DIR;
    delete process.env.PRE_SYNC_BACKUP_DIR;
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;

    if (originalBackupDirEnv === undefined) {
      delete process.env.PRE_SYNC_BACKUP_DIR;
    } else {
      process.env.PRE_SYNC_BACKUP_DIR = originalBackupDirEnv;
    }
  });

  test("passes an absolute bundle path to git when backupDirectory is relative", async () => {
    const spawnCalls: string[][] = [];

    (Bun as any).spawn = mock(({ cmd }: { cmd: string[] }) => {
      spawnCalls.push(cmd);

      return {
        stdout: createEmptyStream(),
        stderr: createEmptyStream(),
        exited: Promise.resolve(0),
      };
    });

    const config: Partial<Config> = {
      userId: "user-123",
      giteaConfig: {
        token: "gitea-token",
        backupBeforeSync: true,
        backupDirectory: "data/repo-backups",
      } as Config["giteaConfig"],
    };

    const result = await createPreSyncBundleBackup({
      config,
      owner: "RayLabsHQ",
      repoName: "gitea-mirror",
      cloneUrl: "https://github.com/RayLabsHQ/gitea-mirror.git",
    });

    expect(path.isAbsolute(result.bundlePath)).toBe(true);

    const bundleCommand = spawnCalls.find(
      (cmd) => cmd[0] === "git" && cmd[3] === "bundle" && cmd[4] === "create"
    );

    expect(bundleCommand).toBeDefined();

    const bundlePathArg = bundleCommand?.[5];
    expect(bundlePathArg).toBe(result.bundlePath);
    expect(path.isAbsolute(bundlePathArg ?? "")).toBe(true);

    const expectedRepoBackupDir = path.resolve(
      "data/repo-backups",
      "user-123",
      "RayLabsHQ",
      "gitea-mirror"
    );

    expect(bundlePathArg?.startsWith(`${expectedRepoBackupDir}${path.sep}`)).toBe(true);
    expect(bundlePathArg?.endsWith(".bundle")).toBe(true);
  });
});
