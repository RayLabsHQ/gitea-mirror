#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import path from "path";
import {
  repairDuplicateSsoColumns,
  repairStrandedBetterAuth17Schema,
  restoreSsoDataAfter0013,
} from "../src/lib/db/migration-repairs";

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

function seedPre0012Database(db: any) {
  // The harness has already run migrations 0000-0011, so the legacy
  // oidc-provider tables exist. Seed a registered client (with the legacy
  // comma-separated redirect_urls format) plus the related token/consent rows
  // to exercise the create/transform/drop paths in 0012.
  db.run("INSERT INTO users (id, email, username, name) VALUES ('u1', 'u1@example.com', 'user1', 'User One')");
  db.run("INSERT INTO oauth_applications (id, client_id, client_secret, name, redirect_urls, type, disabled, user_id) VALUES ('app1', 'client-1', 'secret-1', 'Example App', 'https://example.com/callback,https://example.com/cb2', 'web', false, 'u1')");
  db.run("INSERT INTO oauth_access_tokens (id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, client_id, user_id, scopes) VALUES ('oat1', 'tok', 'rtok', 7000, 8000, 'client-1', 'u1', '[\"repo\"]')");
  db.run("INSERT INTO oauth_consent (id, user_id, client_id, scopes, consent_given) VALUES ('cons1', 'u1', 'client-1', '[\"repo\"]', true)");
}

function verify0012Migration(db: any) {
  // Old provider tables are dropped.
  for (const table of ["oauth_applications", "oauth_consent"]) {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { name: string } | null;
    assert(!row, `Expected ${table} table to be dropped after migration`);
  }

  // New provider tables exist.
  for (const table of ["oauth_clients", "oauth_access_tokens", "oauth_refresh_tokens", "oauth_consents", "jwks"]) {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { name: string } | null;
    assert(row, `Expected ${table} table to exist after migration`);
  }

  // The registered client is preserved and its redirect URIs converted from
  // the legacy comma-separated string into a JSON string[].
  const client = db
    .query("SELECT client_id, client_secret, name, redirect_uris, type, user_id FROM oauth_clients WHERE id = 'app1'")
    .get() as { client_id: string; client_secret: string; name: string; redirect_uris: string; type: string; user_id: string } | null;
  assert(client, "Expected migrated oauth_clients row for app1");
  assert(client.client_id === "client-1", "Expected client_id to be preserved");
  assert(client.name === "Example App", "Expected client name to be preserved");
  assert(client.user_id === "u1", "Expected owner user_id to be preserved");

  const uris = JSON.parse(client.redirect_uris);
  assert(
    Array.isArray(uris) && uris.length === 2 && uris[0] === "https://example.com/callback" && uris[1] === "https://example.com/cb2",
    `Expected redirect_uris to be a JSON array of the two callbacks, got ${client.redirect_uris}`,
  );

  // The reshaped tables accept the new column layout.
  db.run("INSERT INTO oauth_clients (id, client_id, redirect_uris) VALUES ('app2', 'client-2', '[\"https://example.com/cb\"]')");
  db.run("INSERT INTO oauth_refresh_tokens (id, token, client_id, user_id, scopes) VALUES ('rt1', 'refresh-1', 'client-2', 'u1', '[\"openid\"]')");
  db.run("INSERT INTO oauth_access_tokens (id, token, client_id, user_id, scopes) VALUES ('at1', 'access-1', 'client-2', 'u1', '[\"openid\"]')");
  db.run("INSERT INTO oauth_consents (id, client_id, user_id, scopes) VALUES ('co1', 'client-2', 'u1', '[\"openid\"]')");
  db.run("INSERT INTO jwks (id, public_key, private_key) VALUES ('jwk1', 'public', 'private')");
}

function seedPre0013Database(db: any) {
  // Migrations 0000-0012 have run, so sso_providers lacks samlConfig /
  // domainVerified and the organizations table still carries the inherited
  // DEFAULT '' on normalized_name from 0007. Seed both so the table-rebuild
  // and the column-adds can be verified end-to-end.
  db.run("INSERT INTO users (id, email, username, name) VALUES ('u-sso', 'sso@example.com', 'sso', 'SSO User')");
  db.run("INSERT INTO configs (id, user_id, name, is_active, github_config, gitea_config, schedule_config, cleanup_config) VALUES ('cfg-pre13', 'u-sso', 'Default', 1, '{}', '{}', '{}', '{}')");
  db.run("INSERT INTO sso_providers (id, issuer, domain, oidc_config, user_id, provider_id) VALUES ('sso-pre13', 'https://idp.example.com', 'example.com', '{\"clientId\":\"x\"}', 'u-sso', 'idp-pre13')");
  db.run("INSERT INTO organizations (id, user_id, config_id, name, avatar_url, normalized_name) VALUES ('org-pre13', 'u-sso', 'cfg-pre13', 'Example', 'https://example.com/a.png', 'example')");
}

function verify0013Migration(db: any) {
  // New columns on sso_providers.
  const ssoCols = db
    .query("PRAGMA table_info(sso_providers)")
    .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
  const saml = ssoCols.find((c) => c.name === "saml_config");
  const domainVerified = ssoCols.find((c) => c.name === "domain_verified");
  assert(saml, "Expected sso_providers.saml_config column to exist");
  assert(saml.notnull === 0, "Expected saml_config to be nullable");
  assert(domainVerified, "Expected sso_providers.domain_verified column to exist");
  assert(domainVerified.notnull === 1, "Expected domain_verified to be NOT NULL");
  assert(
    domainVerified.dflt_value === "true",
    `Expected domain_verified DEFAULT true, got ${domainVerified.dflt_value}`,
  );

  // Pre-existing SSO row picked up the default (1 = true) on domain_verified.
  const ssoRow = db
    .query("SELECT provider_id, saml_config, domain_verified FROM sso_providers WHERE id = 'sso-pre13'")
    .get() as { provider_id: string; saml_config: string | null; domain_verified: number } | null;
  assert(ssoRow, "Expected pre-existing OIDC provider row to survive migration");
  assert(ssoRow.saml_config === null, `Expected saml_config NULL, got ${ssoRow.saml_config}`);
  assert(ssoRow.domain_verified === 1, `Expected domain_verified=1, got ${ssoRow.domain_verified}`);

  // Organizations rebuild preserved the seeded row and dropped the inherited
  // DEFAULT '' on normalized_name (drizzle reconciles to schema.ts).
  const orgRow = db
    .query("SELECT id, normalized_name FROM organizations WHERE id = 'org-pre13'")
    .get() as { id: string; normalized_name: string } | null;
  assert(orgRow, "Expected pre-existing organization row to survive table rebuild");
  assert(orgRow.normalized_name === "example", `Expected organization normalized_name preserved, got ${orgRow.normalized_name}`);
  const orgCols = db
    .query("PRAGMA table_info(organizations)")
    .all() as Array<{ name: string; dflt_value: string | null }>;
  const normName = orgCols.find((c) => c.name === "normalized_name");
  assert(normName, "Expected organizations.normalized_name column to exist");
  assert(normName.dflt_value === null, `Expected normalized_name to have no default, got ${normName.dflt_value}`);
}

function seedPre0014Database(db: any) {
  // Migrations 0000-0013 have run, so repositories/organizations exist but
  // lack mirror_overrides. Seed one of each so the column-add can be verified
  // against pre-existing rows (they must come out NULL = "inherit").
  db.run("INSERT INTO users (id, email, username, name) VALUES ('u-ovr', 'ovr@example.com', 'ovr', 'Override User')");
  db.run("INSERT INTO configs (id, user_id, name, is_active, github_config, gitea_config, schedule_config, cleanup_config) VALUES ('cfg-pre14', 'u-ovr', 'Default', 1, '{}', '{}', '{}', '{}')");
  db.run("INSERT INTO organizations (id, user_id, config_id, name, avatar_url, normalized_name) VALUES ('org-pre14', 'u-ovr', 'cfg-pre14', 'ExampleOrg', 'https://example.com/a.png', 'exampleorg')");
  db.run(
    "INSERT INTO repositories (id, user_id, config_id, name, full_name, normalized_full_name, url, clone_url, owner, default_branch) " +
      "VALUES ('repo-pre14', 'u-ovr', 'cfg-pre14', 'browser-use', 'ExampleOrg/browser-use', 'exampleorg/browser-use', 'https://github.com/ExampleOrg/browser-use', 'https://github.com/ExampleOrg/browser-use.git', 'ExampleOrg', 'main')",
  );
}

function verify0014Migration(db: any) {
  // Both tables gained a nullable mirror_overrides column with no default.
  for (const table of ["repositories", "organizations"]) {
    const cols = db
      .query(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === "mirror_overrides");
    assert(col, `Expected ${table}.mirror_overrides column to exist`);
    assert(col.notnull === 0, `Expected ${table}.mirror_overrides to be nullable`);
    assert(
      col.dflt_value === null,
      `Expected ${table}.mirror_overrides to have no default, got ${col.dflt_value}`,
    );
  }

  // Pre-existing rows inherit (NULL), rather than being backfilled with {}.
  const repoRow = db
    .query("SELECT id, mirror_overrides FROM repositories WHERE id = 'repo-pre14'")
    .get() as { id: string; mirror_overrides: string | null } | null;
  assert(repoRow, "Expected pre-existing repository row to survive migration");
  assert(
    repoRow.mirror_overrides === null,
    `Expected existing repository to inherit (NULL mirror_overrides), got ${repoRow.mirror_overrides}`,
  );

  const orgRow = db
    .query("SELECT id, mirror_overrides FROM organizations WHERE id = 'org-pre14'")
    .get() as { id: string; mirror_overrides: string | null } | null;
  assert(orgRow, "Expected pre-existing organization row to survive migration");
  assert(
    orgRow.mirror_overrides === null,
    `Expected existing organization to inherit (NULL mirror_overrides), got ${orgRow.mirror_overrides}`,
  );

  // The new column round-trips a JSON overrides payload (the #361 case:
  // mirror this repo but skip its LFS objects).
  db.run(
    "UPDATE repositories SET mirror_overrides = '{\"lfs\":false}' WHERE id = 'repo-pre14'",
  );
  const updated = db
    .query("SELECT mirror_overrides FROM repositories WHERE id = 'repo-pre14'")
    .get() as { mirror_overrides: string } | null;
  assert(updated, "Expected repository row after override update");
  const parsed = JSON.parse(updated.mirror_overrides);
  assert(parsed.lfs === false, `Expected persisted lfs override false, got ${updated.mirror_overrides}`);
}

function seedPre0015Database(db: any) {
  // Migrations 0000-0014 have run, so repositories exist but carry no source
  // columns. Seed one so the column-add can be verified against a
  // pre-existing row: everything before 0015 came from GitHub.
  db.run("INSERT INTO users (id, email, username, name) VALUES ('u-src', 'src@example.com', 'src', 'Source User')");
  db.run("INSERT INTO configs (id, user_id, name, is_active, github_config, gitea_config, schedule_config, cleanup_config) VALUES ('cfg-pre15', 'u-src', 'Default', 1, '{}', '{}', '{}', '{}')");
  db.run(
    "INSERT INTO repositories (id, user_id, config_id, name, full_name, normalized_full_name, url, clone_url, owner, default_branch) " +
      "VALUES ('repo-pre15', 'u-src', 'cfg-pre15', 'tool', 'src/tool', 'src/tool', 'https://github.com/src/tool', 'https://github.com/src/tool.git', 'src', 'main')",
  );
}

function verify0015Migration(db: any) {
  const cols = db
    .query("PRAGMA table_info(repositories)")
    .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;

  for (const [name, expectedDefault] of [
    ["source_provider", "'github'"],
    ["source_url", "'https://github.com'"],
  ] as const) {
    const col = cols.find((c) => c.name === name);
    assert(col, `Expected repositories.${name} column to exist`);
    assert(col.notnull === 1, `Expected repositories.${name} to be NOT NULL`);
    assert(
      col.dflt_value === expectedDefault,
      `Expected repositories.${name} default ${expectedDefault}, got ${col.dflt_value}`,
    );
  }

  // Pre-existing rows are backfilled as GitHub, which is where they came from.
  const existing = db
    .query("SELECT source_provider, source_url FROM repositories WHERE id = 'repo-pre15'")
    .get() as { source_provider: string; source_url: string } | null;
  assert(existing, "Expected pre-existing repository row to survive migration");
  assert(
    existing.source_provider === "github" && existing.source_url === "https://github.com",
    `Expected existing repository to default to GitHub, got ${JSON.stringify(existing)}`,
  );

  // New rows can record another host.
  db.run(
    "INSERT INTO repositories (id, user_id, config_id, name, full_name, normalized_full_name, url, clone_url, owner, default_branch, source_provider, source_url) " +
      "VALUES ('repo-gitlab', 'u-src', 'cfg-pre15', 'tool', 'group/tool', 'group/tool', 'https://gitlab.com/group/tool', 'https://gitlab.com/group/tool.git', 'group', 'main', 'gitlab', 'https://gitlab.com')",
  );
  const inserted = db
    .query("SELECT source_provider, source_url FROM repositories WHERE id = 'repo-gitlab'")
    .get() as { source_provider: string; source_url: string } | null;
  assert(
    inserted?.source_provider === "gitlab" && inserted.source_url === "https://gitlab.com",
    `Expected GitLab source to round-trip, got ${JSON.stringify(inserted)}`,
  );
}

function seedPre0016Database(db: any) {
  // Migrations 0000-0015 have run: accounts have no issuer column and the
  // OAuth provider tables are in their better-auth 1.6 shape. Seed one
  // account of each kind so the issuer backfill can be checked, plus a row
  // in every OAuth table the 1.7 column adds touch.
  db.run("INSERT INTO users (id, email, username, name) VALUES ('u-16', 'u16@example.com', 'u16', 'User Sixteen')");
  db.run("INSERT INTO accounts (id, account_id, user_id, provider_id, password) VALUES ('acct-cred', 'u-16', 'u-16', 'credential', 'hashed')");
  db.run("INSERT INTO sso_providers (id, issuer, domain, oidc_config, user_id, provider_id) VALUES ('sso-16', 'https://idp.example.com', 'example.com', '{}', 'u-16', 'example-oidc')");
  db.run("INSERT INTO accounts (id, account_id, user_id, provider_id) VALUES ('acct-sso', 'sub-123', 'u-16', 'example-oidc')");
  db.run("INSERT INTO accounts (id, account_id, user_id, provider_id) VALUES ('acct-oauth', 'gh-123', 'u-16', 'github')");
  db.run("INSERT INTO oauth_clients (id, client_id, redirect_uris) VALUES ('app-16', 'client-16', '[\"https://example.com/cb\"]')");
  db.run("INSERT INTO oauth_access_tokens (id, token, client_id, user_id, scopes) VALUES ('at-16', 'access-16', 'client-16', 'u-16', '[\"openid\"]')");
  db.run("INSERT INTO oauth_refresh_tokens (id, token, client_id, user_id, scopes) VALUES ('rt-16', 'refresh-16', 'client-16', 'u-16', '[\"openid\"]')");
  db.run("INSERT INTO oauth_consents (id, client_id, user_id, scopes) VALUES ('co-16', 'client-16', 'u-16', '[\"openid\"]')");
  db.run("INSERT INTO jwks (id, public_key, private_key) VALUES ('key-16', 'pub', 'priv')");
}

function verify0016Migration(db: any) {
  // better-auth 1.7 keys accounts by (issuer, accountId); sign-in looks the
  // credential account up with issuer "local:credential", so the backfill
  // is what keeps existing users able to log in.
  const issuers = Object.fromEntries(
    (db.query("SELECT id, issuer FROM accounts ORDER BY id").all() as Array<{ id: string; issuer: string }>).map(
      (row) => [row.id, row.issuer],
    ),
  );
  assert(issuers["acct-cred"] === "local:credential", `Expected credential account issuer local:credential, got ${issuers["acct-cred"]}`);
  assert(issuers["acct-sso"] === "https://idp.example.com", `Expected SSO account to take its provider issuer, got ${issuers["acct-sso"]}`);
  assert(issuers["acct-oauth"] === "local:oauth:github", `Expected OAuth account issuer local:oauth:github, got ${issuers["acct-oauth"]}`);

  const accountCols = db.query("PRAGMA table_info(accounts)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
  const issuerCol = accountCols.find((c) => c.name === "issuer");
  assert(issuerCol && issuerCol.notnull === 1, "Expected accounts.issuer to be NOT NULL");

  // jwks gained nullable alg and crv.
  const jwksCols = db.query("PRAGMA table_info(jwks)").all() as Array<{ name: string; notnull: number }>;
  for (const name of ["alg", "crv"]) {
    const col = jwksCols.find((c) => c.name === name);
    assert(col && col.notnull === 0, `Expected jwks.${name} to exist and be nullable`);
  }
  const key = db.query("SELECT id, alg FROM jwks WHERE id = 'key-16'").get() as { id: string; alg: string | null } | null;
  assert(key && key.alg === null, "Expected existing jwks row to survive with NULL alg");

  // Columns added for @better-auth/oauth-provider 1.7, all nullable so
  // pre-existing rows are untouched.
  const expectedNewColumns: Record<string, string[]> = {
    oauth_clients: [
      "client_discovery_id",
      "client_credentials_scopes",
      "backchannel_logout_uri",
      "backchannel_logout_session_required",
      "application_type",
      "jwks",
      "jwks_uri",
      "dpop_bound_access_tokens",
    ],
    oauth_access_tokens: ["authorization_code_id", "resources", "requested_user_info_claims", "revoked", "confirmation"],
    oauth_refresh_tokens: [
      "authorization_code_id",
      "resources",
      "requested_user_info_claims",
      "rotated_at",
      "rotation_replay_response",
      "rotation_replay_expires_at",
      "confirmation",
    ],
    oauth_consents: ["resources", "requested_user_info_claims"],
  };
  for (const [table, columns] of Object.entries(expectedNewColumns)) {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
    for (const column of columns) {
      const col = cols.find((c) => c.name === column);
      assert(col, `Expected ${table}.${column} column to exist`);
      assert(col.notnull === 0, `Expected ${table}.${column} to be nullable`);
    }
  }

  // Seeded rows survive the column adds.
  for (const [table, id] of [
    ["oauth_clients", "app-16"],
    ["oauth_access_tokens", "at-16"],
    ["oauth_refresh_tokens", "rt-16"],
    ["oauth_consents", "co-16"],
  ] as const) {
    const row = db.query(`SELECT id FROM ${table} WHERE id = '${id}'`).get();
    assert(row, `Expected ${table} row '${id}' to survive migration`);
  }

  // The three new 1.7 tables exist and accept rows.
  db.run("INSERT INTO oauth_resources (id, identifier, name) VALUES ('res-16', 'https://api.example.com', 'Example API')");
  db.run("INSERT INTO oauth_client_resources (id, client_id, resource_id) VALUES ('cr-16', 'client-16', 'https://api.example.com')");
  db.run("INSERT INTO oauth_client_assertions (id, expires_at) VALUES ('jti-16', 1234567890)");
}

function seedPre0017Database(db: any) {
  // Migrations 0000-0016 have run. Seed a user so the api_keys foreign key
  // has something to point at, and confirm the table does not exist yet.
  db.run("INSERT INTO users (id, email, username, name) VALUES ('u-17', 'u17@example.com', 'u17', 'User Seventeen')");
  const before = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").get();
  assert(!before, "Expected api_keys to be absent before migration 0017");
}

function verify0017Migration(db: any) {
  // The table the @better-auth/api-key plugin writes to. Column names are
  // what the drizzle table in schema.ts declares; the plugin addresses them
  // through the drizzle field names, so a rename here breaks key creation.
  const cols = db.query("PRAGMA table_info(api_keys)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const names = cols.map((c) => c.name);
  for (const expected of [
    "id",
    "config_id",
    "name",
    "start",
    "prefix",
    "key",
    "reference_id",
    "refill_interval",
    "refill_amount",
    "last_refill_at",
    "enabled",
    "rate_limit_enabled",
    "rate_limit_time_window",
    "rate_limit_max",
    "request_count",
    "remaining",
    "last_request",
    "expires_at",
    "created_at",
    "updated_at",
    "permissions",
    "metadata",
  ]) {
    assert(names.includes(expected), `Expected api_keys.${expected} column to exist`);
  }
  const keyCol = cols.find((c) => c.name === "key");
  assert(keyCol && keyCol.notnull === 1, "Expected api_keys.key to be NOT NULL");
  const configCol = cols.find((c) => c.name === "config_id");
  assert(configCol && configCol.dflt_value === "'default'", "Expected api_keys.config_id to default to 'default'");

  const indexes = (db.query("PRAGMA index_list(api_keys)").all() as Array<{ name: string }>).map((i) => i.name);
  assert(indexes.includes("idx_api_keys_reference_id"), "Expected an index on api_keys.reference_id");
  assert(indexes.includes("idx_api_keys_key"), "Expected an index on api_keys.key");

  // A row shaped like what the plugin inserts, then the cascade when the
  // owning user goes away.
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    "INSERT INTO api_keys (id, name, start, prefix, key, reference_id, enabled, rate_limit_enabled, request_count, created_at, updated_at) " +
      "VALUES ('key-17', 'ci', 'gm_abcdefg', 'gm_', 'hashed-key', 'u-17', 1, 0, 0, unixepoch(), unixepoch())",
  );
  const inserted = db.query("SELECT expires_at, config_id FROM api_keys WHERE id = 'key-17'").get() as {
    expires_at: number | null;
    config_id: string;
  } | null;
  assert(inserted && inserted.expires_at === null, "Expected a key without expiry to store NULL expires_at");
  assert(inserted.config_id === "default", "Expected config_id to take the default");

  let rejected = false;
  try {
    db.run("INSERT INTO api_keys (id, key, reference_id, created_at, updated_at) VALUES ('key-orphan', 'h', 'no-such-user', unixepoch(), unixepoch())");
  } catch {
    rejected = true;
  }
  assert(rejected, "Expected api_keys.reference_id to require an existing user");

  db.run("DELETE FROM users WHERE id = 'u-17'");
  const remaining = db.query("SELECT COUNT(*) AS count FROM api_keys").get() as { count: number };
  assert(remaining.count === 0, "Expected deleting a user to cascade to their API keys");
}

const MIGRATION_0012_TIMESTAMP = 1774062000000;
const MIGRATION_0013_TIMESTAMP = 1780377747526;

/**
 * Reproduce the issue #312 crash state — sso_providers already carries
 * saml_config / domain_verified before migration 0013 runs (stranded on an
 * intermediate build), with __drizzle_migrations recorded only through 0012 —
 * and verify repairDuplicateSsoColumns()/restoreSsoDataAfter0013() let the
 * canonical 0013 run while preserving real SAML provider data.
 */
function validateBroken0013Repair() {
  const migration0013 = migrations.find((m) => m.entry.tag === "0013_slim_galactus");
  if (!migration0013) return; // 0013 not present (shouldn't happen) — nothing to test.

  const db = new Database(":memory:");
  try {
    runMigrations(db, migrations.slice(0, 13)); // 0000-0012

    // A real upgraded instance has a __drizzle_migrations table recorded
    // through 0012 but not 0013.
    db.run(
      "CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)",
    );
    db.run("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES ('through-0012', ?)", [
      MIGRATION_0012_TIMESTAMP,
    ]);

    // Stranded columns from the intermediate build.
    db.run("ALTER TABLE sso_providers ADD saml_config text");
    db.run("ALTER TABLE sso_providers ADD domain_verified integer DEFAULT true NOT NULL");

    db.run("INSERT INTO users (id, email, username, name) VALUES ('u1', 'u1@example.com', 'u1', 'User One')");
    const samlJson = '{"entryPoint":"https://idp.example.com/sso","cert":"ABC123"}';
    db.run(
      "INSERT INTO sso_providers (id, issuer, domain, oidc_config, user_id, provider_id, saml_config, domain_verified) VALUES ('oidc1', 'https://idp', 'a.com', '{}', 'u1', 'p-oidc', NULL, 1)",
    );
    db.run(
      "INSERT INTO sso_providers (id, issuer, domain, oidc_config, user_id, provider_id, saml_config, domain_verified) VALUES ('saml1', 'https://idp', 'b.com', '{}', 'u1', 'p-saml', ?, 1)",
      [samlJson],
    );
    db.run(
      "INSERT INTO sso_providers (id, issuer, domain, oidc_config, user_id, provider_id, saml_config, domain_verified) VALUES ('unv1', 'https://idp', 'c.com', '{}', 'u1', 'p-unv', NULL, 0)",
    );

    const preserved = repairDuplicateSsoColumns(db);

    const colsAfterRepair = (db.query("PRAGMA table_info(sso_providers)").all() as TableInfoRow[]).map(
      (c) => c.name,
    );
    assert(!colsAfterRepair.includes("saml_config"), "Expected repair to drop stranded saml_config column");
    assert(
      !colsAfterRepair.includes("domain_verified"),
      "Expected repair to drop stranded domain_verified column",
    );
    const preservedIds = preserved.map((r) => r.id).sort();
    assert(
      preservedIds.length === 2 && preservedIds[0] === "saml1" && preservedIds[1] === "unv1",
      `Expected SAML + unverified rows to be preserved, got ${JSON.stringify(preservedIds)}`,
    );

    // The canonical 0013 must now run without a duplicate-column error.
    runMigration(db, migration0013);
    restoreSsoDataAfter0013(db, preserved);

    const rows = db
      .query("SELECT id, saml_config, domain_verified FROM sso_providers ORDER BY id")
      .all() as Array<{ id: string; saml_config: string | null; domain_verified: number }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    assert(byId.oidc1.saml_config === null, "Expected OIDC provider saml_config to remain NULL");
    assert(byId.oidc1.domain_verified === 1, "Expected OIDC provider domain_verified default 1");
    assert(byId.saml1.saml_config === samlJson, "Expected SAML provider config to be preserved");
    assert(byId.saml1.domain_verified === 1, "Expected SAML provider domain_verified preserved as 1");
    assert(byId.unv1.saml_config === null, "Expected unverified provider saml_config NULL");
    assert(byId.unv1.domain_verified === 0, "Expected explicit domain_verified=0 to be preserved");

    // Idempotency: 0013 is now applied, so a re-run of the repair is a no-op.
    db.run("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES ('through-0013', ?)", [
      MIGRATION_0013_TIMESTAMP,
    ]);
    const secondPass = repairDuplicateSsoColumns(db);
    assert(secondPass.length === 0, "Expected repair to no-op once migration 0013 is recorded");
    const colsAfterSecondPass = (
      db.query("PRAGMA table_info(sso_providers)").all() as TableInfoRow[]
    ).map((c) => c.name);
    assert(
      colsAfterSecondPass.includes("saml_config") && colsAfterSecondPass.includes("domain_verified"),
      "Expected columns to remain intact on the no-op second pass",
    );
  } finally {
    db.close();
  }
}

const MIGRATION_0015_TIMESTAMP = 1788333701612;

/**
 * Reproduce a database that booted the reverted better-auth 1.7.0-rc.4 build:
 * migrations recorded through 0015, but the three rc tables and some of the
 * rc columns already present. Migration 0016 must fail on it as-is, and
 * repairStrandedBetterAuth17Schema() must reconcile it so 0016 then runs and
 * backfills account issuers.
 */
function validateStranded0016Repair() {
  const migration0016 = migrations.find((m) => m.entry.tag === "0016_better_auth_1_7");
  if (!migration0016) return;

  const db = new Database(":memory:");
  try {
    runMigrations(db, migrations.slice(0, 16)); // 0000-0015
    db.run(
      "CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)",
    );
    db.run("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES ('through-0015', ?)", [
      MIGRATION_0015_TIMESTAMP,
    ]);

    // Leftovers from the rc build.
    db.run("CREATE TABLE oauth_client_assertions (id text PRIMARY KEY NOT NULL, expires_at integer NOT NULL)");
    db.run("CREATE TABLE oauth_resources (id text PRIMARY KEY NOT NULL, identifier text NOT NULL, name text NOT NULL)");
    db.run("ALTER TABLE oauth_clients ADD client_discovery_id text");
    db.run("ALTER TABLE oauth_access_tokens ADD resources text");

    db.run("INSERT INTO users (id, email, username, name) VALUES ('u-rc', 'rc@example.com', 'rc', 'RC User')");
    db.run("INSERT INTO accounts (id, account_id, user_id, provider_id, password) VALUES ('acct-rc', 'u-rc', 'u-rc', 'credential', 'hashed')");

    // As-is, 0016 cannot run: the CREATE TABLE collides.
    let failedAsIs = false;
    try {
      runMigration(db, migration0016);
    } catch {
      failedAsIs = true;
    }
    assert(failedAsIs, "Expected migration 0016 to fail on the rc leftovers without the repair");

    const dropped = repairStrandedBetterAuth17Schema(db);
    assert(dropped === 4, `Expected the repair to drop 2 tables and 2 columns, dropped ${dropped}`);

    runMigration(db, migration0016);

    const account = db
      .query("SELECT issuer FROM accounts WHERE id = 'acct-rc'")
      .get() as { issuer: string } | null;
    assert(account?.issuer === "local:credential", `Expected the credential account to be backfilled after the repair, got ${account?.issuer}`);
    const clientCols = (db.query("PRAGMA table_info(oauth_clients)").all() as TableInfoRow[]).map((c) => c.name);
    assert(clientCols.includes("client_discovery_id") && clientCols.includes("jwks_uri"), "Expected 0016 to re-add the oauth_clients columns in full");
    db.run("INSERT INTO oauth_client_assertions (id, expires_at) VALUES ('jti-rc', 1)");

    // Idempotency: with 0016 recorded the repair is a no-op.
    db.run("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES ('through-0016', ?)", [
      1788336988526,
    ]);
    assert(repairStrandedBetterAuth17Schema(db) === 0, "Expected the repair to no-op once migration 0016 is recorded");
  } finally {
    db.close();
  }
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
  "0012_oauth_provider_migration": {
    seed: seedPre0012Database,
    verify: verify0012Migration,
  },
  "0013_slim_galactus": {
    seed: seedPre0013Database,
    verify: verify0013Migration,
  },
  "0014_needy_white_tiger": {
    seed: seedPre0014Database,
    verify: verify0014Migration,
  },
  "0015_source_provider": {
    seed: seedPre0015Database,
    verify: verify0015Migration,
  },
  "0016_better_auth_1_7": {
    seed: seedPre0016Database,
    verify: verify0016Migration,
  },
  "0017_api_keys": {
    seed: seedPre0017Database,
    verify: verify0017Migration,
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

  // Exercise the runtime repair for the issue #312 duplicate-column crash.
  validateBroken0013Repair();

  // Exercise the repair for databases that booted the reverted 1.7.0-rc.4 build.
  validateStranded0016Repair();

  console.log(
    `Validated ${migrations.length} migrations from scratch and upgrade path for ${latestMigration.entry.tag}, plus the #312 SSO-column repair and the better-auth 1.7 rc repair.`,
  );
}

try {
  validateMigrations();
} catch (error) {
  console.error("Migration validation failed:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
