import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "@/types/config";
import {
  resolveBackupPaths,
  resolveBackupStrategy,
  shouldBackupForStrategy,
  shouldBlockSyncForStrategy,
  strategyNeedsDetection,
} from "@/lib/repo-backup";

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

// ---- Backup strategy resolver tests ----

function makeConfig(overrides: Record<string, any> = {}): Partial<Config> {
  return {
    giteaConfig: {
      url: "https://gitea.example.com",
      token: "tok",
      ...overrides,
    },
  } as Partial<Config>;
}

const envKeysToClean = ["PRE_SYNC_BACKUP_STRATEGY", "PRE_SYNC_BACKUP_ENABLED"];

describe("resolveBackupStrategy", () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of envKeysToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("returns explicit backupStrategy when set", () => {
    expect(resolveBackupStrategy(makeConfig({ backupStrategy: "always" }))).toBe("always");
    expect(resolveBackupStrategy(makeConfig({ backupStrategy: "disabled" }))).toBe("disabled");
    expect(resolveBackupStrategy(makeConfig({ backupStrategy: "on-force-push" }))).toBe("on-force-push");
    expect(resolveBackupStrategy(makeConfig({ backupStrategy: "block-on-force-push" }))).toBe("block-on-force-push");
  });

  test("maps backupBeforeSync: true → 'always' (backward compat)", () => {
    expect(resolveBackupStrategy(makeConfig({ backupBeforeSync: true }))).toBe("always");
  });

  test("maps backupBeforeSync: false → 'disabled' (backward compat)", () => {
    expect(resolveBackupStrategy(makeConfig({ backupBeforeSync: false }))).toBe("disabled");
  });

  test("prefers explicit backupStrategy over backupBeforeSync", () => {
    expect(
      resolveBackupStrategy(
        makeConfig({ backupStrategy: "on-force-push", backupBeforeSync: true }),
      ),
    ).toBe("on-force-push");
  });

  test("falls back to PRE_SYNC_BACKUP_STRATEGY env var", () => {
    process.env.PRE_SYNC_BACKUP_STRATEGY = "block-on-force-push";
    expect(resolveBackupStrategy(makeConfig({}))).toBe("block-on-force-push");
  });

  test("falls back to PRE_SYNC_BACKUP_ENABLED env var (legacy)", () => {
    process.env.PRE_SYNC_BACKUP_ENABLED = "false";
    expect(resolveBackupStrategy(makeConfig({}))).toBe("disabled");
  });

  test("defaults to 'on-force-push' when nothing is configured", () => {
    expect(resolveBackupStrategy(makeConfig({}))).toBe("on-force-push");
  });

  test("handles empty giteaConfig gracefully", () => {
    expect(resolveBackupStrategy({})).toBe("on-force-push");
  });
});

describe("shouldBackupForStrategy", () => {
  test("disabled → never backup", () => {
    expect(shouldBackupForStrategy("disabled", false)).toBe(false);
    expect(shouldBackupForStrategy("disabled", true)).toBe(false);
  });

  test("always → always backup", () => {
    expect(shouldBackupForStrategy("always", false)).toBe(true);
    expect(shouldBackupForStrategy("always", true)).toBe(true);
  });

  test("on-force-push → backup only when detected", () => {
    expect(shouldBackupForStrategy("on-force-push", false)).toBe(false);
    expect(shouldBackupForStrategy("on-force-push", true)).toBe(true);
  });

  test("block-on-force-push → backup only when detected", () => {
    expect(shouldBackupForStrategy("block-on-force-push", false)).toBe(false);
    expect(shouldBackupForStrategy("block-on-force-push", true)).toBe(true);
  });
});

describe("shouldBlockSyncForStrategy", () => {
  test("only block-on-force-push + detected returns true", () => {
    expect(shouldBlockSyncForStrategy("block-on-force-push", true)).toBe(true);
  });

  test("block-on-force-push without detection does not block", () => {
    expect(shouldBlockSyncForStrategy("block-on-force-push", false)).toBe(false);
  });

  test("other strategies never block", () => {
    expect(shouldBlockSyncForStrategy("disabled", true)).toBe(false);
    expect(shouldBlockSyncForStrategy("always", true)).toBe(false);
    expect(shouldBlockSyncForStrategy("on-force-push", true)).toBe(false);
  });
});

describe("strategyNeedsDetection", () => {
  test("returns true for detection-based strategies", () => {
    expect(strategyNeedsDetection("on-force-push")).toBe(true);
    expect(strategyNeedsDetection("block-on-force-push")).toBe(true);
  });

  test("returns false for non-detection strategies", () => {
    expect(strategyNeedsDetection("disabled")).toBe(false);
    expect(strategyNeedsDetection("always")).toBe(false);
  });
});
