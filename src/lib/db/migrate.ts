/**
 * Database migration utilities for v3.0.0
 */
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { ENV } from "@/lib/config";
import fs from "fs";
import path from "path";

const MIGRATION_TABLE = "__drizzle_migrations";

/**
 * Get database path from environment
 */
export function getDatabasePath(): string {
  const dbUrl = ENV.DATABASE_URL;
  if (dbUrl.startsWith("sqlite://")) {
    return dbUrl.replace("sqlite://", "");
  }
  if (dbUrl.startsWith("file:")) {
    return dbUrl.replace("file:", "");
  }
  return dbUrl;
}

/**
 * Check if this is a v2.x database (no migration table)
 */
export function isLegacyDatabase(db: Database): boolean {
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const hasMigrationTable = tables.some(t => t.name === MIGRATION_TABLE);
    const hasUserTable = tables.some(t => t.name === "users");
    
    // Legacy database if it has users but no migration table
    return hasUserTable && !hasMigrationTable;
  } catch {
    return false;
  }
}

/**
 * Run database migrations
 */
export async function runDrizzleMigrations(): Promise<void> {
  const dbPath = getDatabasePath();
  
  // Ensure data directory exists
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  console.log("🔄 Running Drizzle migrations...");
  
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  
  try {
    // Check if this is a legacy database
    if (isLegacyDatabase(sqlite)) {
      console.log("⚠️  Detected v2.x database. Please run the v3 migration script first.");
      console.log("   Run: bun scripts/migrate-v2-to-v3.ts");
      throw new Error("Legacy database detected - migration required");
    }
    
    // Run migrations
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✅ Migrations completed successfully");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    throw error;
  } finally {
    sqlite.close();
  }
}

/**
 * Initialize database with migrations
 */
export async function initializeDatabase(): Promise<void> {
  const dbPath = getDatabasePath();
  const dbExists = fs.existsSync(dbPath);
  
  if (dbExists) {
    console.log("📁 Existing database found, running migrations...");
  } else {
    console.log("🆕 Creating new database...");
  }
  
  await runDrizzleMigrations();
}