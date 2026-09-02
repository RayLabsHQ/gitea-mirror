import type { Database } from "bun:sqlite";

/**
 * Pre-migration repairs that reconcile a database into the exact shape Drizzle's
 * migrator expects, so a previously-failed migration can complete on the next
 * boot. These run BEFORE `migrate()` and are deliberately defensive: any failure
 * is logged and swallowed so they never make a recoverable database worse.
 */

/** Migration 0013 journal timestamp (from drizzle/meta/_journal.json, idx 13). */
const MIGRATION_0013_TIMESTAMP = 1780377747526;

export type PreservedSsoRow = {
  id: string;
  saml_config?: string | null;
  domain_verified?: number;
};

/**
 * Repair the v3.17.0 (PR #307) "duplicate column name: saml_config" crash loop
 * reported in issue #312.
 *
 * Some instances ended up with `sso_providers.saml_config` / `domain_verified`
 * already present BEFORE migration 0013 ran — the columns were declared in
 * schema.ts and entered the DB via `db:push` or an SSO-register round-trip on an
 * intermediate build, while `__drizzle_migrations` never recorded a 0013 row.
 *
 * Migration 0013 runs as a single transaction (organizations rebuild + the two
 * `ALTER TABLE sso_providers ADD ...`). The ADD hits the pre-existing column,
 * throws "duplicate column", and rolls back the ENTIRE transaction — so 0013 is
 * never recorded and is retried, failing identically, on every boot.
 *
 * This is the mirror image of the 0009 repair in index.ts (record present,
 * column missing): here the column is present but the record is missing. We
 * reconcile `sso_providers` back to its true pre-0013 shape so the canonical
 * 0013 can run in full (the organizations rebuild MUST NOT be skipped),
 * preserving any real SAML provider config across the drop/re-add.
 *
 * Returns the rows whose values must be re-applied by {@link restoreSsoDataAfter0013}
 * once 0013 has re-added the columns. Returns an empty array when there is
 * nothing to do (fresh install, clean upgrade, or genuine pre-0013 shape).
 */
export function repairDuplicateSsoColumns(sqlite: Database): PreservedSsoRow[] {
  try {
    const migrationsTableExists = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get();

    // Fresh install — no migrations recorded yet, vanilla migrate() handles it.
    if (!migrationsTableExists) return [];

    // 0013 already recorded (clean upgrade / already healed) — nothing to do.
    const alreadyApplied = sqlite
      .query("SELECT 1 FROM __drizzle_migrations WHERE created_at >= ? LIMIT 1")
      .get(MIGRATION_0013_TIMESTAMP);
    if (alreadyApplied) return [];

    const ssoExists = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='sso_providers'")
      .get();
    if (!ssoExists) return [];

    const cols = sqlite.query("PRAGMA table_info(sso_providers)").all() as { name: string }[];
    const hasSaml = cols.some((c) => c.name === "saml_config");
    const hasDomainVerified = cols.some((c) => c.name === "domain_verified");

    // Genuine pre-0013 shape — let migration 0013 add the columns as-is.
    if (!hasSaml && !hasDomainVerified) return [];

    console.log(
      "🔧 Detected stranded SSO columns (migration 0013 not recorded). Reconciling sso_providers so 0013 can run...",
    );

    // Preserve any real data before dropping. SAML providers store JSON config
    // in saml_config; domain_verified may have been explicitly set to false.
    const selectCols = ["id"];
    if (hasSaml) selectCols.push("saml_config");
    if (hasDomainVerified) selectCols.push("domain_verified");
    const preserved = sqlite
      .query(`SELECT ${selectCols.join(", ")} FROM sso_providers`)
      .all() as PreservedSsoRow[];

    // SQLite >= 3.35 (bun:sqlite ships much newer) supports DROP COLUMN.
    if (hasSaml) sqlite.run("ALTER TABLE sso_providers DROP COLUMN saml_config");
    if (hasDomainVerified) sqlite.run("ALTER TABLE sso_providers DROP COLUMN domain_verified");

    // Only rows whose values differ from the 0013 defaults (saml_config NULL,
    // domain_verified true/1) need restoring after the columns are re-added.
    return preserved.filter(
      (r) => (hasSaml && r.saml_config != null) || (hasDomainVerified && r.domain_verified === 0),
    );
  } catch (error) {
    console.warn("⚠️ SSO column repair check failed (non-fatal):", error);
    return [];
  }
}

/**
 * Re-apply the SSO provider values preserved by {@link repairDuplicateSsoColumns}
 * once migration 0013 has re-added saml_config / domain_verified with their
 * defaults (saml_config NULL, domain_verified = 1). No-op when nothing was
 * preserved (the common OIDC-only case).
 */
export function restoreSsoDataAfter0013(sqlite: Database, preserved: PreservedSsoRow[]): void {
  if (preserved.length === 0) return;
  try {
    const stmt = sqlite.prepare(
      "UPDATE sso_providers SET saml_config = ?, domain_verified = ? WHERE id = ?",
    );
    for (const r of preserved) {
      stmt.run(r.saml_config ?? null, r.domain_verified ?? 1, r.id);
    }
    console.log(`✅ Restored ${preserved.length} preserved SSO provider value(s) after migration 0013.`);
  } catch (error) {
    console.warn("⚠️ Failed to restore preserved SSO data (non-fatal):", error);
  }
}

/** Migration 0016 journal timestamp (from drizzle/meta/_journal.json, idx 16). */
const MIGRATION_0016_TIMESTAMP = 1788336988526;

/**
 * Everything migration 0016 (better-auth 1.7) adds. A database that ran the
 * reverted 1.7.0-rc.4 build (commit 2f6af22, on main for a few minutes on
 * 2026-08-06, and any dev database that booted it) already has some of these,
 * without a 0016 record. Migration 0016 is one transaction, so its first
 * CREATE TABLE fails with "already exists" and every boot crashes the same way.
 */
const BETTER_AUTH_17_TABLES = ["oauth_client_assertions", "oauth_client_resources", "oauth_resources"];
const BETTER_AUTH_17_COLUMNS: Record<string, string[]> = {
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
  accounts: ["issuer"],
  jwks: ["alg", "crv"],
};

/**
 * Reconcile a database that carries part of the better-auth 1.7 schema
 * without migration 0016 being recorded, so the canonical 0016 can run.
 *
 * The stranded tables only ever existed on the unreleased rc build and the
 * stranded columns are all nullable additions, so dropping them loses nothing
 * a released version wrote. `accounts.issuer` is regenerated by the 0016
 * backfill from `provider_id`, which is exactly what better-auth writes.
 *
 * Returns the number of tables and columns dropped; 0 means nothing to do.
 */
export function repairStrandedBetterAuth17Schema(sqlite: Database): number {
  try {
    const migrationsTableExists = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get();
    // Fresh install: vanilla migrate() handles it.
    if (!migrationsTableExists) return 0;

    // 0016 already recorded (clean upgrade / already healed): nothing to do.
    const alreadyApplied = sqlite
      .query("SELECT 1 FROM __drizzle_migrations WHERE created_at >= ? LIMIT 1")
      .get(MIGRATION_0016_TIMESTAMP);
    if (alreadyApplied) return 0;

    const existingTables = new Set(
      (sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );

    const strandedTables = BETTER_AUTH_17_TABLES.filter((table) => existingTables.has(table));
    const strandedColumns: Array<{ table: string; column: string }> = [];
    for (const [table, columns] of Object.entries(BETTER_AUTH_17_COLUMNS)) {
      if (!existingTables.has(table)) continue;
      const present = new Set(
        (sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
      );
      for (const column of columns) {
        if (present.has(column)) strandedColumns.push({ table, column });
      }
    }

    // Genuine pre-0016 shape: let migration 0016 add everything as-is.
    if (strandedTables.length === 0 && strandedColumns.length === 0) return 0;

    console.log(
      `🔧 Detected a partial better-auth 1.7 schema (migration 0016 not recorded): ${strandedTables.length} table(s), ${strandedColumns.length} column(s). Reconciling so 0016 can run...`,
    );

    for (const table of strandedTables) {
      sqlite.run(`DROP TABLE IF EXISTS ${table}`);
    }
    // SQLite >= 3.35 (bun:sqlite ships much newer) supports DROP COLUMN.
    for (const { table, column } of strandedColumns) {
      sqlite.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }

    return strandedTables.length + strandedColumns.length;
  } catch (error) {
    console.warn("⚠️ better-auth 1.7 schema repair check failed (non-fatal):", error);
    return 0;
  }
}
