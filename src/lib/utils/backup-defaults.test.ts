/**
 * PRE_SYNC_BACKUP_* seed a new configuration's backup fields, and a stored
 * value keeps winning (#503).
 *
 * The helpers are tested in this process. The two places that create a
 * configuration, createDefaultConfig and the env loader, run against the real
 * schema in an in-memory SQLite database. They import @/lib/db, which is
 * replaced with that database through mock.module; bun's mock.module is
 * process-wide and leaks into other test files, so that part re-runs this
 * file in an isolated child (same harness as
 * src/pages/api/organizations/export.test.ts).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { backupDefaultsFromEnv, backupStrategyFromEnv, storedBackupStrategy } from "./backup-defaults";

const CHILD_FLAG = "GM_BACKUP_DEFAULTS_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

const BACKUP_ENV = [
  "PRE_SYNC_BACKUP_STRATEGY",
  "PRE_SYNC_BACKUP_ENABLED",
  "PRE_SYNC_BACKUP_KEEP_COUNT",
  "PRE_SYNC_BACKUP_RETENTION_DAYS",
  "PRE_SYNC_BACKUP_DIR",
];

/** Clears the backup variables for each test and puts them back after. */
function isolateBackupEnv() {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    for (const key of BACKUP_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

if (!isChild) {
  describe("backupDefaultsFromEnv", () => {
    isolateBackupEnv();

    test("without variables it gives the usual defaults", () => {
      expect(backupDefaultsFromEnv()).toEqual({
        backupStrategy: "on-force-push",
        backupBeforeSync: true,
        backupRetentionCount: 5,
        backupRetentionDays: 30,
        backupDirectory: undefined,
      });
    });

    test("reads every variable", () => {
      process.env.PRE_SYNC_BACKUP_STRATEGY = " Disabled ";
      process.env.PRE_SYNC_BACKUP_KEEP_COUNT = "2";
      process.env.PRE_SYNC_BACKUP_RETENTION_DAYS = "7";
      process.env.PRE_SYNC_BACKUP_DIR = " /backups ";
      expect(backupDefaultsFromEnv()).toEqual({
        backupStrategy: "disabled",
        backupBeforeSync: false,
        backupRetentionCount: 2,
        backupRetentionDays: 7,
        backupDirectory: "/backups",
      });
    });

    test("ignores values it cannot use", () => {
      process.env.PRE_SYNC_BACKUP_STRATEGY = "sometimes";
      process.env.PRE_SYNC_BACKUP_KEEP_COUNT = "0";
      process.env.PRE_SYNC_BACKUP_RETENTION_DAYS = "soon";
      process.env.PRE_SYNC_BACKUP_DIR = "  ";
      const defaults = backupDefaultsFromEnv();
      expect(defaults.backupStrategy).toBe("on-force-push");
      expect(defaults.backupRetentionCount).toBe(5);
      expect(defaults.backupRetentionDays).toBe(30);
      expect(defaults.backupDirectory).toBeUndefined();
    });

    test("the legacy switch maps true to always and anything else to disabled", () => {
      process.env.PRE_SYNC_BACKUP_ENABLED = "yes";
      expect(backupStrategyFromEnv()).toBe("always");
      process.env.PRE_SYNC_BACKUP_ENABLED = "false";
      expect(backupStrategyFromEnv()).toBe("disabled");
      expect(backupDefaultsFromEnv().backupBeforeSync).toBe(false);
    });

    test("PRE_SYNC_BACKUP_STRATEGY wins over the legacy switch", () => {
      process.env.PRE_SYNC_BACKUP_STRATEGY = "block-on-force-push";
      process.env.PRE_SYNC_BACKUP_ENABLED = "false";
      expect(backupStrategyFromEnv()).toBe("block-on-force-push");
    });
  });

  describe("storedBackupStrategy", () => {
    test("reads the strategy, then the deprecated boolean, and nothing else", () => {
      expect(storedBackupStrategy({ backupStrategy: "always", backupBeforeSync: false })).toBe("always");
      expect(storedBackupStrategy({ backupBeforeSync: true })).toBe("on-force-push");
      expect(storedBackupStrategy({ backupBeforeSync: false })).toBe("disabled");
      expect(storedBackupStrategy({ backupStrategy: "sometimes" })).toBeUndefined();
      expect(storedBackupStrategy({})).toBeUndefined();
      expect(storedBackupStrategy(undefined)).toBeUndefined();
    });
  });

  test("configuration seeding - isolated child suite", () => {
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

const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite });

/** Apply every migration in drizzle/ in journal order, the way the migrator would. */
function applyMigrations(): void {
  const folder = join(process.cwd(), "drizzle");
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    const sql = readFileSync(join(folder, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.run(statement);
    }
  }
}

const LOADER_ENV: Record<string, string> = {
  GITHUB_USERNAME: "octocat",
  GITHUB_TOKEN: "ghp_test",
  GITEA_URL: "https://gitea.example.com",
  GITEA_USERNAME: "mirror",
  GITEA_TOKEN: "gitea_test",
};

if (isChild) {
  process.env.ENCRYPTION_SECRET ??= "backup-defaults-test-secret-0123456789";
  applyMigrations();
  mock.module("@/lib/db", () => ({ ...schema, db }));
}

const { createDefaultConfig } = isChild
  ? await import("./config-defaults")
  : ({} as Partial<typeof import("./config-defaults")>);
const { initializeConfigFromEnv } = isChild
  ? await import("@/lib/env-config-loader")
  : ({} as Partial<typeof import("@/lib/env-config-loader")>);

async function storedGitea(userId = "user-1") {
  const rows = await db.select().from(schema.configs).where(eq(schema.configs.userId, userId));
  expect(rows).toHaveLength(1);
  return rows[0].giteaConfig as Record<string, unknown>;
}

if (isChild) {
  describe("a new configuration starts from PRE_SYNC_BACKUP_*", () => {
    isolateBackupEnv();

    beforeEach(() => {
      sqlite.run("DELETE FROM sources");
      sqlite.run("DELETE FROM configs");
      sqlite.run("DELETE FROM users");
      sqlite.run("INSERT INTO users (id, email) VALUES ('user-1', 'one@example.com')");
      for (const key of Object.keys(LOADER_ENV)) delete process.env[key];
    });

    afterEach(() => {
      for (const key of Object.keys(LOADER_ENV)) delete process.env[key];
    });

    function setBackupEnv() {
      process.env.PRE_SYNC_BACKUP_STRATEGY = "disabled";
      process.env.PRE_SYNC_BACKUP_KEEP_COUNT = "2";
      process.env.PRE_SYNC_BACKUP_RETENTION_DAYS = "7";
      process.env.PRE_SYNC_BACKUP_DIR = "/backups";
    }

    test("createDefaultConfig stores the variables", async () => {
      setBackupEnv();
      await createDefaultConfig!({ userId: "user-1" });
      expect(await storedGitea()).toMatchObject({
        backupStrategy: "disabled",
        backupBeforeSync: false,
        backupRetentionCount: 2,
        backupRetentionDays: 7,
        backupDirectory: "/backups",
      });
    });

    test("createDefaultConfig keeps the usual defaults without them", async () => {
      await createDefaultConfig!({ userId: "user-1" });
      expect(await storedGitea()).toMatchObject({
        backupStrategy: "on-force-push",
        backupBeforeSync: true,
        backupRetentionCount: 5,
        backupRetentionDays: 30,
        backupDirectory: "data/repo-backups",
      });
    });

    test("the env loader stores the variables on first boot", async () => {
      Object.assign(process.env, LOADER_ENV);
      setBackupEnv();
      await initializeConfigFromEnv!();
      expect(await storedGitea()).toMatchObject({
        url: "https://gitea.example.com",
        backupStrategy: "disabled",
        backupBeforeSync: false,
        backupRetentionCount: 2,
        backupRetentionDays: 7,
        backupDirectory: "/backups",
      });
    });

    test("the env loader keeps stored backup settings over the variables", async () => {
      await createDefaultConfig!({ userId: "user-1" });
      Object.assign(process.env, LOADER_ENV);
      setBackupEnv();
      await initializeConfigFromEnv!();
      expect(await storedGitea()).toMatchObject({
        url: "https://gitea.example.com",
        backupStrategy: "on-force-push",
        backupBeforeSync: true,
        backupRetentionCount: 5,
        backupRetentionDays: 30,
        backupDirectory: "data/repo-backups",
      });
    });

    test("the env loader keeps a legacy backupBeforeSync: false as disabled", async () => {
      await createDefaultConfig!({ userId: "user-1" });
      const legacy = await storedGitea();
      delete legacy.backupStrategy;
      legacy.backupBeforeSync = false;
      await db.update(schema.configs).set({ giteaConfig: legacy as any }).where(eq(schema.configs.userId, "user-1"));

      Object.assign(process.env, LOADER_ENV);
      await initializeConfigFromEnv!();
      expect(await storedGitea()).toMatchObject({ backupStrategy: "disabled", backupBeforeSync: false });
    });
  });
}
