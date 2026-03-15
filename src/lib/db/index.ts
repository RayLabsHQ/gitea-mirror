import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "fs";
import path from "path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

// Skip database initialization in test environment
let db: ReturnType<typeof drizzle>;

if (process.env.NODE_ENV !== "test") {
  // Define the database URL - for development we'll use a local SQLite file
  const dataDir = path.join(process.cwd(), "data");
  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, "gitea-mirror.db");

  // Create an empty database file if it doesn't exist
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, "");
  }

  // Create SQLite database instance using Bun's native driver
  let sqlite: Database;
  try {
    sqlite = new Database(dbPath);
    console.log("Successfully connected to SQLite database using Bun's native driver");
  } catch (error) {
    console.error("Error opening database:", error);
    throw error;
  }

  // Create drizzle instance with the SQLite client
  db = drizzle({ client: sqlite });

  /**
   * Fix migration records that were marked as applied but whose DDL actually
   * failed (e.g. the v3.13.0 release where ALTER TABLE with expression default
   * was rejected by SQLite). Without this, Drizzle skips the migration on
   * retry because it thinks it already ran.
   *
   * Drizzle tracks migrations by `created_at` (= journal timestamp) and only
   * looks at the most recent record. If the last recorded timestamp is >= the
   * failed migration's timestamp but the expected column is missing, we delete
   * stale records so the migration re-runs.
   */
  function repairFailedMigrations() {
    try {
      const migrationsTableExists = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
        .get();

      if (!migrationsTableExists) return;

      // Migration 0009 journal timestamp (from drizzle/meta/_journal.json)
      const MIGRATION_0009_TIMESTAMP = 1773542995732;

      const lastMigration = sqlite
        .query("SELECT id, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
        .get() as { id: number; created_at: number } | null;

      if (!lastMigration || Number(lastMigration.created_at) < MIGRATION_0009_TIMESTAMP) return;

      // Migration 0009 is recorded as applied — verify the column actually exists
      const columns = sqlite.query("PRAGMA table_info(repositories)").all() as { name: string }[];
      const hasImportedAt = columns.some((c) => c.name === "imported_at");

      if (!hasImportedAt) {
        console.log("🔧 Detected failed migration 0009 (imported_at column missing). Removing stale record so it can re-run...");
        sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(MIGRATION_0009_TIMESTAMP);
      }
    } catch (error) {
      console.warn("⚠️ Migration repair check failed (non-fatal):", error);
    }
  }

  /**
   * Run Drizzle migrations
   */
  function runDrizzleMigrations() {
    try {
      console.log("🔄 Checking for pending migrations...");

      // Check if migrations table exists
      const migrationsTableExists = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
        .get();

      if (!migrationsTableExists) {
        console.log("📦 First time setup - running initial migrations...");
      }

      // Fix any migrations that were recorded but actually failed (e.g. v3.13.0 bug)
      repairFailedMigrations();

      // Run migrations using Drizzle migrate function
      migrate(db, { migrationsFolder: "./drizzle" });

      console.log("✅ Database migrations completed successfully");
    } catch (error) {
      console.error("❌ Error running migrations:", error);
      throw error;
    }
  }

  // Run Drizzle migrations after db is initialized
  runDrizzleMigrations();
}

export { db };

// Export all table definitions from schema
export { 
  users, 
  events, 
  configs, 
  repositories, 
  mirrorJobs, 
  organizations,
  sessions,
  accounts,
  verificationTokens,
  verifications,
  oauthApplications,
  oauthAccessTokens,
  oauthConsent,
  ssoProviders,
  rateLimits
} from "./schema";
