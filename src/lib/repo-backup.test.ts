import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "@/types/config";
import { resolveBackupPaths } from "@/lib/repo-backup";

describe("resolveBackupPaths", () => {
  let originalBackupDirEnv: string | undefined;

  beforeEach(() => {
    originalBackupDirEnv = process.env.PRE_SYNC_BACKUP_DIR;
    delete process.env.PRE_SYNC_BACKUP_DIR;
  });

  afterEach(() => {
    if (originalBackupDirEnv === undefined) {
      delete process.env.PRE_SYNC_BACKUP_DIR;
    } else {
      process.env.PRE_SYNC_BACKUP_DIR = originalBackupDirEnv;
    }
  });

  test("returns absolute paths when backupDirectory is relative", () => {
    const config: Partial<Config> = {
      userId: "user-123",
      giteaConfig: {
        backupDirectory: "data/repo-backups",
      } as Config["giteaConfig"],
    };

    const { backupRoot, repoBackupDir } = resolveBackupPaths({
      config,
      owner: "RayLabsHQ",
      repoName: "gitea-mirror",
    });

    expect(path.isAbsolute(backupRoot)).toBe(true);
    expect(path.isAbsolute(repoBackupDir)).toBe(true);
    expect(repoBackupDir).toBe(
      path.join(backupRoot, "user-123", "RayLabsHQ", "gitea-mirror")
    );
  });

  test("returns absolute paths when backupDirectory is already absolute", () => {
    const config: Partial<Config> = {
      userId: "user-123",
      giteaConfig: {
        backupDirectory: "/data/repo-backups",
      } as Config["giteaConfig"],
    };

    const { backupRoot, repoBackupDir } = resolveBackupPaths({
      config,
      owner: "owner",
      repoName: "repo",
    });

    expect(backupRoot).toBe("/data/repo-backups");
    expect(path.isAbsolute(repoBackupDir)).toBe(true);
  });

  test("falls back to cwd-based path when no backupDirectory is set", () => {
    const config: Partial<Config> = {
      userId: "user-123",
      giteaConfig: {} as Config["giteaConfig"],
    };

    const { backupRoot } = resolveBackupPaths({
      config,
      owner: "owner",
      repoName: "repo",
    });

    expect(path.isAbsolute(backupRoot)).toBe(true);
    expect(backupRoot).toBe(
      path.resolve(process.cwd(), "data", "repo-backups")
    );
  });

  test("uses PRE_SYNC_BACKUP_DIR env var when config has no backupDirectory", () => {
    process.env.PRE_SYNC_BACKUP_DIR = "custom/backup/path";

    const config: Partial<Config> = {
      userId: "user-123",
      giteaConfig: {} as Config["giteaConfig"],
    };

    const { backupRoot } = resolveBackupPaths({
      config,
      owner: "owner",
      repoName: "repo",
    });

    expect(path.isAbsolute(backupRoot)).toBe(true);
    expect(backupRoot).toBe(path.resolve("custom/backup/path"));
  });

  test("sanitizes owner and repoName in path segments", () => {
    const config: Partial<Config> = {
      userId: "user-123",
      giteaConfig: {
        backupDirectory: "/backups",
      } as Config["giteaConfig"],
    };

    const { repoBackupDir } = resolveBackupPaths({
      config,
      owner: "org/with-slash",
      repoName: "repo name!",
    });

    expect(repoBackupDir).toBe(
      path.join("/backups", "user-123", "org_with-slash", "repo_name_")
    );
  });
});
