/**
 * Database migration utilities for adding authentication features
 */

import { Database } from "bun:sqlite";
import { ENV } from "@/lib/config";
import fs from "fs";
import path from "path";

/**
 * Get database path
 */
function getDatabasePath(): string {
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
 * Check if a column exists in a table
 */
function columnExists(db: Database, tableName: string, columnName: string): boolean {
  try {
    const result = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: any;
      pk: number;
    }>;
    
    return result.some(column => column.name === columnName);
  } catch (error) {
    console.error(`Error checking column ${columnName} in table ${tableName}:`, error);
    return false;
  }
}

/**
 * Migration: Add authentication fields to users table
 */
export function migrateUsersTableForAuth(): boolean {
  try {
    const dbPath = getDatabasePath();
    
    // Ensure data directory exists
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    const db = new Database(dbPath);
    
    console.log("🔄 Migrating users table for authentication features...");
    
    // Check if migrations are needed
    const migrations = [
      { column: "display_name", sql: "ALTER TABLE users ADD COLUMN display_name TEXT" },
      { column: "auth_provider", sql: "ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local'" },
      { column: "external_id", sql: "ALTER TABLE users ADD COLUMN external_id TEXT" },
      { column: "external_username", sql: "ALTER TABLE users ADD COLUMN external_username TEXT" },
      { column: "is_active", sql: "ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1" },
      { column: "last_login_at", sql: "ALTER TABLE users ADD COLUMN last_login_at INTEGER" },
    ];
    
    let migrationsApplied = 0;
    
    for (const migration of migrations) {
      if (!columnExists(db, "users", migration.column)) {
        console.log(`  Adding column: ${migration.column}`);
        db.exec(migration.sql);
        migrationsApplied++;
      } else {
        console.log(`  Column already exists: ${migration.column}`);
      }
    }
    
    // Make password column nullable for existing users with external auth
    // Note: SQLite doesn't support ALTER COLUMN, so we'll handle this in the application logic
    
    db.close();
    
    if (migrationsApplied > 0) {
      console.log(`✅ Applied ${migrationsApplied} migrations to users table`);
    } else {
      console.log("✅ Users table is already up to date");
    }
    
    return true;
  } catch (error) {
    console.error("❌ Failed to migrate users table:", error);
    return false;
  }
}

/**
 * Check if a table exists
 */
function tableExists(db: Database, tableName: string): boolean {
  try {
    const result = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as any;
    return result !== null;
  } catch (error) {
    console.error(`Error checking table ${tableName}:`, error);
    return false;
  }
}

/**
 * Migration: Create auth_config table
 */
export function createAuthConfigTable(): boolean {
  try {
    const dbPath = getDatabasePath();
    const db = new Database(dbPath);
    
    console.log("🔄 Creating auth_config table...");
    
    if (!tableExists(db, "auth_config")) {
      db.exec(`
        CREATE TABLE auth_config (
          id TEXT PRIMARY KEY,
          method TEXT NOT NULL DEFAULT 'local',
          allowLocalFallback INTEGER NOT NULL DEFAULT 0,
          forwardAuth TEXT,
          oidc TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        )
      `);
      console.log("✅ Created auth_config table");
    } else {
      console.log("✅ auth_config table already exists");
    }
    
    db.close();
    return true;
  } catch (error) {
    console.error("❌ Failed to create auth_config table:", error);
    return false;
  }
}

/**
 * Run all pending migrations
 */
export function runMigrations(): boolean {
  console.log("🔄 Running database migrations...");
  
  try {
    // Run users table migration
    const usersResult = migrateUsersTableForAuth();
    
    // Create auth_config table
    const authConfigResult = createAuthConfigTable();
    
    if (usersResult && authConfigResult) {
      console.log("✅ All migrations completed successfully");
      return true;
    } else {
      console.log("❌ Some migrations failed");
      return false;
    }
  } catch (error) {
    console.error("❌ Migration process failed:", error);
    return false;
  }
}

/**
 * Check if migrations are needed
 */
export function checkMigrationsNeeded(): boolean {
  try {
    const dbPath = getDatabasePath();
    
    if (!fs.existsSync(dbPath)) {
      return false; // New database, no migrations needed
    }
    
    const db = new Database(dbPath);
    
    // Check if auth columns exist
    const authColumns = ["auth_provider", "external_id", "is_active"];
    const needsMigration = authColumns.some(column => !columnExists(db, "users", column));
    
    db.close();
    
    return needsMigration;
  } catch (error) {
    console.error("Error checking migration status:", error);
    return false;
  }
}
