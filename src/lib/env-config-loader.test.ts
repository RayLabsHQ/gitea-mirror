/**
 * The env loader runs on every start once a GitHub or Gitea credential is set
 * through the environment. A true/false variable that is not set must keep
 * what the Configuration page stored. It used to read as false and was saved
 * over it, so topics, issue mirroring, private repositories, the schedule and
 * more turned back off at each restart.
 *
 * Runs against the real schema in an in-memory SQLite database that replaces
 * @/lib/db through mock.module, so the file runs in its own process.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { runsIsolated } from "@/tests/isolated";

const isolated = runsIsolated(import.meta.path);

const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite });

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

/** The credentials that make the loader run. */
const CREDENTIALS: Record<string, string> = {
  GITHUB_USERNAME: "octocat",
  GITHUB_TOKEN: "ghp_test",
  GITEA_URL: "https://gitea.example.com",
  GITEA_USERNAME: "mirror",
  GITEA_TOKEN: "gitea_test",
};

/** Every variable a test here sets, cleared before each test. */
const TOUCHED = [
  ...Object.keys(CREDENTIALS),
  "GITEA_ADD_TOPICS",
  "MIRROR_ISSUES",
  "PRIVATE_REPOSITORIES",
  "SKIP_FORKS",
  "SCHEDULE_ENABLED",
  "SCHEDULE_SKIP_RECENTLY_MIRRORED",
  "GITEA_MIRROR_INTERVAL",
  "SCHEDULE_INTERVAL",
  "DELAY",
  "AUTO_IMPORT_REPOS",
  "CLEANUP_ENABLED",
  "CLEANUP_DELETE_IF_NOT_IN_GITHUB",
  "CLEANUP_DRY_RUN",
  "MIRROR_STRATEGY",
  "PRESERVE_ORG_STRUCTURE",
  "GITEA_ORGANIZATION",
  "ENVIRONMENT_SEEDING",
];

if (isolated) {
  process.env.ENCRYPTION_SECRET ??= "env-config-loader-test-secret-0123456789";
  applyMigrations();
  mock.module("@/lib/db", () => ({ ...schema, db }));
}

const { createDefaultConfig } = isolated
  ? await import("@/lib/utils/config-defaults")
  : ({} as Partial<typeof import("@/lib/utils/config-defaults")>);
const { initializeConfigFromEnv } = isolated
  ? await import("@/lib/env-config-loader")
  : ({} as Partial<typeof import("@/lib/env-config-loader")>);

async function stored() {
  const rows = await db.select().from(schema.configs).where(eq(schema.configs.userId, "user-1"));
  expect(rows).toHaveLength(1);
  return rows[0] as any;
}

/** Saves what a user would set on the Configuration page. */
async function storeFromConfigurationPage() {
  await createDefaultConfig!({ userId: "user-1" });
  const row = await stored();
  await db
    .update(schema.configs)
    .set({
      githubConfig: { ...row.githubConfig, includePrivate: true, skipForks: true, includeForks: false },
      giteaConfig: { ...row.giteaConfig, addTopics: true, mirrorIssues: true },
      scheduleConfig: { ...row.scheduleConfig, enabled: true, skipRecentlyMirrored: true, autoImport: false },
      cleanupConfig: { ...row.cleanupConfig, enabled: true, deleteIfNotInGitHub: true, dryRun: false },
    })
    .where(eq(schema.configs.userId, "user-1"));
}

if (isolated) {
  describe("env loader true/false variables", () => {
    beforeEach(() => {
      sqlite.run("DELETE FROM sources");
      sqlite.run("DELETE FROM configs");
      sqlite.run("DELETE FROM users");
      sqlite.run("INSERT INTO users (id, email) VALUES ('user-1', 'one@example.com')");
      for (const key of TOUCHED) delete process.env[key];
      Object.assign(process.env, CREDENTIALS);
    });

    test("keep what the Configuration page stored when they are not set", async () => {
      await storeFromConfigurationPage();

      await initializeConfigFromEnv!();

      const row = await stored();
      expect(row.githubConfig).toMatchObject({ includePrivate: true, skipForks: true, includeForks: false });
      expect(row.giteaConfig).toMatchObject({ addTopics: true, mirrorIssues: true });
      expect(row.scheduleConfig).toMatchObject({ enabled: true, skipRecentlyMirrored: true, autoImport: false });
      expect(row.cleanupConfig).toMatchObject({ enabled: true, deleteIfNotInGitHub: true, dryRun: false });
    });

    test("set to false still turn a switch off", async () => {
      await storeFromConfigurationPage();
      process.env.GITEA_ADD_TOPICS = "false";
      process.env.MIRROR_ISSUES = "false";
      process.env.SCHEDULE_ENABLED = "false";
      process.env.AUTO_IMPORT_REPOS = "false";
      process.env.CLEANUP_ENABLED = "false";

      await initializeConfigFromEnv!();

      const row = await stored();
      expect(row.giteaConfig).toMatchObject({ addTopics: false, mirrorIssues: false });
      expect(row.scheduleConfig).toMatchObject({ enabled: false, autoImport: false });
      expect(row.cleanupConfig.enabled).toBe(false);
    });

    test("set to true turn a switch on, in any case", async () => {
      await createDefaultConfig!({ userId: "user-1" });
      process.env.MIRROR_ISSUES = "TRUE";
      process.env.PRIVATE_REPOSITORIES = "true";

      await initializeConfigFromEnv!();

      const row = await stored();
      expect(row.giteaConfig).toMatchObject({ mirrorIssues: true, mirrorMetadata: true });
      expect(row.githubConfig.includePrivate).toBe(true);
    });

    test("an interval variable still switches the schedule on, next to SCHEDULE_ENABLED=false", async () => {
      await createDefaultConfig!({ userId: "user-1" });
      process.env.SCHEDULE_ENABLED = "false";
      process.env.GITEA_MIRROR_INTERVAL = "8h";

      await initializeConfigFromEnv!();

      expect((await stored()).scheduleConfig.enabled).toBe(true);
    });

    test("CLEANUP_DELETE_IF_NOT_IN_GITHUB=true switches cleanup on", async () => {
      await createDefaultConfig!({ userId: "user-1" });
      const row = await stored();
      await db
        .update(schema.configs)
        .set({ cleanupConfig: { ...row.cleanupConfig, enabled: false } })
        .where(eq(schema.configs.userId, "user-1"));
      process.env.CLEANUP_DELETE_IF_NOT_IN_GITHUB = "true";

      await initializeConfigFromEnv!();

      expect((await stored()).cleanupConfig).toMatchObject({ enabled: true, deleteIfNotInGitHub: true });
    });

    test("a first start without a stored configuration gets the documented defaults", async () => {
      await initializeConfigFromEnv!();

      const row = await stored();
      expect(row.giteaConfig.addTopics).toBe(true);
      expect(row.scheduleConfig).toMatchObject({ skipRecentlyMirrored: true, autoImport: true });
      expect(row.cleanupConfig).toMatchObject({ deleteIfNotInGitHub: true, dryRun: true });
    });

    test("keep a mirror strategy chosen on the Configuration page", async () => {
      await createDefaultConfig!({ userId: "user-1" });
      const row = await stored();
      await db
        .update(schema.configs)
        .set({ githubConfig: { ...row.githubConfig, mirrorStrategy: "mixed" } })
        .where(eq(schema.configs.userId, "user-1"));
      process.env.GITEA_ORGANIZATION = "github-mirrors";

      await initializeConfigFromEnv!();

      expect((await stored()).githubConfig.mirrorStrategy).toBe("mixed");
    });

    test("work out the strategy as before when it is set or nothing is stored", async () => {
      process.env.GITEA_ORGANIZATION = "github-mirrors";
      await initializeConfigFromEnv!();
      expect((await stored()).githubConfig.mirrorStrategy).toBe("single-org");

      process.env.PRESERVE_ORG_STRUCTURE = "true";
      await initializeConfigFromEnv!();
      expect((await stored()).githubConfig.mirrorStrategy).toBe("preserve");

      process.env.MIRROR_STRATEGY = "flat-user";
      await initializeConfigFromEnv!();
      expect((await stored()).githubConfig.mirrorStrategy).toBe("flat-user");
    });
  });

  describe("ENVIRONMENT_SEEDING (#541)", () => {
    beforeEach(async () => {
      sqlite.run("DELETE FROM sources");
      sqlite.run("DELETE FROM configs");
      sqlite.run("DELETE FROM users");
      sqlite.run("INSERT INTO users (id, email) VALUES ('user-1', 'one@example.com')");
      for (const key of TOUCHED) delete process.env[key];
      await createDefaultConfig!({ userId: "user-1" });
    });

    test("without a connection variable, nothing is copied by default", async () => {
      process.env.AUTO_IMPORT_REPOS = "false";

      await initializeConfigFromEnv!();

      expect((await stored()).scheduleConfig.autoImport).not.toBe(false);
    });

    test("true copies settings without a connection variable and keeps the stored connection", async () => {
      const before = await stored();
      process.env.ENVIRONMENT_SEEDING = "TRUE";
      process.env.AUTO_IMPORT_REPOS = "false";

      await initializeConfigFromEnv!();

      const row = await stored();
      expect(row.scheduleConfig.autoImport).toBe(false);
      expect(row.githubConfig.owner).toBe(before.githubConfig.owner);
      expect(row.githubConfig.token).toBe(before.githubConfig.token);
      expect(row.giteaConfig.url).toBe(before.giteaConfig.url);
      expect(row.giteaConfig.token).toBe(before.giteaConfig.token);
      expect(row.giteaConfig.defaultOwner).toBe(before.giteaConfig.defaultOwner);
      const sources = await db.select().from(schema.sources).where(eq(schema.sources.userId, "user-1"));
      expect(sources).toHaveLength(0);
    });

    test("false copies nothing, even with the connection variables set", async () => {
      Object.assign(process.env, CREDENTIALS);
      process.env.ENVIRONMENT_SEEDING = "false";
      process.env.AUTO_IMPORT_REPOS = "false";

      await initializeConfigFromEnv!();

      const row = await stored();
      expect(row.scheduleConfig.autoImport).not.toBe(false);
      expect(row.githubConfig.owner).not.toBe("octocat");
      expect(row.giteaConfig.defaultOwner).not.toBe("mirror");
    });

    test("any other value is ignored and the connection variables decide", async () => {
      process.env.ENVIRONMENT_SEEDING = "1";
      process.env.AUTO_IMPORT_REPOS = "false";

      await initializeConfigFromEnv!();
      expect((await stored()).scheduleConfig.autoImport).not.toBe(false);

      Object.assign(process.env, CREDENTIALS);
      await initializeConfigFromEnv!();
      expect((await stored()).scheduleConfig.autoImport).toBe(false);
    });
  });
}
