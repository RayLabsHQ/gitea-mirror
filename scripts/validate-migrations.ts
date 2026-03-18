#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import path from "path";

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
};

type Migration = {
  entry: JournalEntry;
  statements: string[];
};

type UpgradeFixture = {
  seed: (db: Database) => void;
  verify: (db: Database) => void;
};

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

const migrationsFolder = path.join(process.cwd(), "drizzle");
const migrations = loadMigrations();
const latestMigration = migrations.at(-1);

/**
 * Known SQLite limitations that Drizzle-kit's auto-generated migrations
 * can violate. Each rule is checked against every SQL statement.
 */
const SQLITE_LINT_RULES: { pattern: RegExp; message: string }[] = [
  {
    pattern: /ALTER\s+TABLE\s+\S+\s+ADD\s+(?:COLUMN\s+)?\S+[^;]*DEFAULT\s*\(/i,
    message:
      "ALTER TABLE ADD COLUMN with an expression default (e.g. DEFAULT (unixepoch())) " +
      "is not allowed in SQLite. Use the table-recreation pattern instead " +
      "(CREATE new table, INSERT SELECT, DROP old, RENAME).",
  },
  {
    pattern: /ALTER\s+TABLE\s+\S+\s+ADD\s+(?:COLUMN\s+)?\S+[^;]*DEFAULT\s+CURRENT_(TIME|DATE|TIMESTAMP)\b/i,
    message:
      "ALTER TABLE ADD COLUMN with DEFAULT CURRENT_TIME/CURRENT_DATE/CURRENT_TIMESTAMP " +
      "is not allowed in SQLite. Use the table-recreation pattern instead.",
  },
];

function loadMigrations(): Migration[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };

  return journal.entries.map((entry) => {
    const migrationPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    const statements = readFileSync(migrationPath, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    return { entry, statements };
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function runMigration(db: Database, migration: Migration) {
  db.run("BEGIN");

  try {
    for (const statement of migration.statements) {
      db.run(statement);
    }

    db.run("COMMIT");
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Ignore rollback errors so the original failure is preserved.
    }

    throw error;
  }
}

function runMigrations(db: Database, selectedMigrations: Migration[]) {
  for (const migration of selectedMigrations) {
    runMigration(db, migration);
  }
}

function seedPre0009Database(db: Database) {
  // Seed every existing table so ALTER TABLE paths run against non-empty data.
  db.run("INSERT INTO users (id, email, username, name) VALUES ('u1', 'u1@example.com', 'user1', 'User One')");
  db.run("INSERT INTO configs (id, user_id, name, github_config, gitea_config, schedule_config, cleanup_config) VALUES ('c1', 'u1', 'Default', '{}', '{}', '{}', '{}')");
  db.run("INSERT INTO accounts (id, account_id, user_id, provider_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope) VALUES ('acct1', 'acct-1', 'u1', 'github', 'access-token', 'refresh-token', 'id-token', 2000, 3000, 'repo')");
  db.run("INSERT INTO events (id, user_id, channel, payload) VALUES ('evt1', 'u1', 'sync', '{\"status\":\"queued\"}')");
  db.run("INSERT INTO mirror_jobs (id, user_id, repository_id, repository_name, status, message, timestamp) VALUES ('job1', 'u1', 'r1', 'owner/repo', 'imported', 'Imported repository', 900)");
  db.run("INSERT INTO organizations (id, user_id, config_id, name, avatar_url, public_repository_count, private_repository_count, fork_repository_count) VALUES ('org1', 'u1', 'c1', 'Example Org', 'https://example.com/org.png', 1, 0, 0)");
  db.run("INSERT INTO repositories (id, user_id, config_id, name, full_name, normalized_full_name, url, clone_url, owner, organization, default_branch, created_at, updated_at, metadata) VALUES ('r1', 'u1', 'c1', 'repo', 'owner/repo', 'owner/repo', 'https://example.com/repo', 'https://example.com/repo.git', 'owner', 'Example Org', 'main', 1000, 1100, '{\"issues\":true}')");
  db.run("INSERT INTO sessions (id, token, user_id, expires_at) VALUES ('sess1', 'session-token', 'u1', 4000)");
  db.run("INSERT INTO verification_tokens (id, token, identifier, type, expires_at) VALUES ('vt1', 'verify-token', 'u1@example.com', 'email', 5000)");
  db.run("INSERT INTO verifications (id, identifier, value, expires_at) VALUES ('ver1', 'u1@example.com', '123456', 6000)");
  db.run("INSERT INTO oauth_applications (id, client_id, client_secret, name, redirect_urls, type, user_id) VALUES ('app1', 'client-1', 'secret-1', 'Example App', '[\"https://example.com/callback\"]', 'confidential', 'u1')");
  db.run("INSERT INTO oauth_access_tokens (id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, client_id, user_id, scopes) VALUES ('oat1', 'oauth-access-token', 'oauth-refresh-token', 7000, 8000, 'client-1', 'u1', '[\"repo\"]')");
  db.run("INSERT INTO oauth_consent (id, user_id, client_id, scopes, consent_given) VALUES ('consent1', 'u1', 'client-1', '[\"repo\"]', true)");
  db.run("INSERT INTO sso_providers (id, issuer, domain, oidc_config, user_id, provider_id) VALUES ('sso1', 'https://issuer.example.com', 'example.com', '{}', 'u1', 'provider-1')");
  db.run("INSERT INTO rate_limits (id, user_id, provider, `limit`, remaining, used, reset, retry_after, status, last_checked) VALUES ('rl1', 'u1', 'github', 5000, 4999, 1, 9000, NULL, 'ok', 8500)");
}

function verify0009Migration(db: Database) {
  const repositoryColumns = db.query("PRAGMA table_info(repositories)").all() as TableInfoRow[];
  const importedAtColumn = repositoryColumns.find((column) => column.name === "imported_at");

  assert(importedAtColumn, "Expected repositories.imported_at column to exist after migration");
  assert(importedAtColumn.notnull === 1, "Expected repositories.imported_at to be NOT NULL");
  assert(importedAtColumn.dflt_value === "unixepoch()", `Expected repositories.imported_at default to be unixepoch(), got ${importedAtColumn.dflt_value ?? "null"}`);

  const existingRepo = db.query("SELECT imported_at FROM repositories WHERE id = 'r1'").get() as { imported_at: number } | null;
  assert(existingRepo?.imported_at === 900, `Expected existing repository imported_at to backfill from mirror_jobs timestamp 900, got ${existingRepo?.imported_at ?? "null"}`);

  db.run("INSERT INTO repositories (id, user_id, config_id, name, full_name, normalized_full_name, url, clone_url, owner, default_branch) VALUES ('r2', 'u1', 'c1', 'repo-two', 'owner/repo-two', 'owner/repo-two', 'https://example.com/repo-two', 'https://example.com/repo-two.git', 'owner', 'main')");
  const newRepo = db.query("SELECT imported_at FROM repositories WHERE id = 'r2'").get() as { imported_at: number } | null;
  assert(typeof newRepo?.imported_at === "number" && newRepo.imported_at > 0, "Expected new repository insert to receive imported_at from the column default");

  const importedAtIndex = db
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'repositories' AND name = 'idx_repositories_user_imported_at'")
    .get() as { name: string } | null;
  assert(importedAtIndex?.name === "idx_repositories_user_imported_at", "Expected repositories imported_at index to exist after migration");
}

function seedPre0010Database(db: any) {
  // Seed a repo row to verify index creation doesn't break existing data
  seedPre0009Database(db);
}

function verify0010Migration(db: any) {
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='uniq_repositories_user_mirrored_location'"
  ).all();
  if (indexes.length === 0) {
    throw new Error("Missing unique partial index uniq_repositories_user_mirrored_location");
  }

  const lookupIdx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_repositories_mirrored_location'"
  ).all();
  if (lookupIdx.length === 0) {
    throw new Error("Missing lookup index idx_repositories_mirrored_location");
  }
}

function seedPre0011Database(db: any) {
  seedPre0009Database(db);
  runMigration(db, migrations.find((m) => m.entry.tag === "0009_nervous_tyger_tiger")!);
  runMigration(db, migrations.find((m) => m.entry.tag === "0010_mirrored_location_index")!);
}

function verify0011Migration(db: any) {
  const configColumns = db.query("PRAGMA table_info(configs)").all() as TableInfoRow[];
  const notificationConfigColumn = configColumns.find((column: any) => column.name === "notification_config");

  assert(notificationConfigColumn, "Expected configs.notification_config column to exist after migration");
  assert(notificationConfigColumn.notnull === 1, "Expected configs.notification_config to be NOT NULL");
  assert(
    notificationConfigColumn.dflt_value !== null,
    "Expected configs.notification_config to have a default value",
  );

  const existingConfig = db.query("SELECT notification_config FROM configs WHERE id = 'c1'").get() as { notification_config: string } | null;
  assert(existingConfig, "Expected existing config row to still exist");
  const parsed = JSON.parse(existingConfig.notification_config);
  assert(parsed.enabled === false, "Expected default notification_config.enabled to be false");
  assert(parsed.provider === "ntfy", "Expected default notification_config.provider to be 'ntfy'");
}

const latestUpgradeFixtures: Record<string, UpgradeFixture> = {
  "0009_nervous_tyger_tiger": {
    seed: seedPre0009Database,
    verify: verify0009Migration,
  },
  "0010_mirrored_location_index": {
    seed: seedPre0010Database,
    verify: verify0010Migration,
  },
  "0011_notification_config": {
    seed: seedPre0011Database,
    verify: verify0011Migration,
  },
};

function lintMigrations(selectedMigrations: Migration[]) {
  const violations: string[] = [];

  for (const migration of selectedMigrations) {
    for (const statement of migration.statements) {
      for (const rule of SQLITE_LINT_RULES) {
        if (rule.pattern.test(statement)) {
          violations.push(`[${migration.entry.tag}] ${rule.message}\n  Statement: ${statement.slice(0, 120)}...`);
        }
      }
    }
  }

  assert(
    violations.length === 0,
    `SQLite lint found ${violations.length} violation(s):\n\n${violations.join("\n\n")}`,
  );
}

function validateMigrations() {
  assert(latestMigration, "No migrations found in drizzle/meta/_journal.json");

  // Lint all migrations for known SQLite pitfalls before running anything.
  lintMigrations(migrations);

  const emptyDb = new Database(":memory:");
  try {
    runMigrations(emptyDb, migrations);
  } finally {
    emptyDb.close();
  }

  const upgradeFixture = latestUpgradeFixtures[latestMigration.entry.tag];
  assert(
    upgradeFixture,
    `Missing upgrade fixture for latest migration ${latestMigration.entry.tag}. Add one in scripts/validate-migrations.ts.`,
  );

  const upgradeDb = new Database(":memory:");
  try {
    runMigrations(upgradeDb, migrations.slice(0, -1));
    upgradeFixture.seed(upgradeDb);
    runMigration(upgradeDb, latestMigration);
    upgradeFixture.verify(upgradeDb);
  } finally {
    upgradeDb.close();
  }

  console.log(
    `Validated ${migrations.length} migrations from scratch and upgrade path for ${latestMigration.entry.tag}.`,
  );
}

try {
  validateMigrations();
} catch (error) {
  console.error("Migration validation failed:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
