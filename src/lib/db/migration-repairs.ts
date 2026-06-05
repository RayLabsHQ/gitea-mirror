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
