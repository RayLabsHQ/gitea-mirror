/**
 * Database connection and initialization for v3.0.0
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";
import { getDatabasePath } from "./migrate";
import fs from "fs";
import path from "path";

// Get database path
const dbPath = getDatabasePath();

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Global database instance
let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database | null = null;

/**
 * Initialize database and run migrations
 */
async function initializeDatabase() {
  if (_db && _sqlite) {
    return { db: _db, sqlite: _sqlite };
  }

  try {
    // Create SQLite connection
    _sqlite = new Database(dbPath);
    _db = drizzle(_sqlite, { schema });
    
    // Run migrations
    console.log("🔄 Checking database migrations...");
    await migrate(_db, { migrationsFolder: "./drizzle" });
    console.log("✅ Database ready");
    
    return { db: _db, sqlite: _sqlite };
  } catch (error) {
    console.error("❌ Database initialization failed:", error);
    throw error;
  }
}

/**
 * Get database instance
 */
export async function getDb() {
  if (!_db) {
    await initializeDatabase();
  }
  return _db!;
}

/**
 * Get raw SQLite instance (for legacy queries)
 */
export async function getSqlite() {
  if (!_sqlite) {
    await initializeDatabase();
  }
  return _sqlite!;
}

/**
 * Close database connections
 */
export function closeDatabase() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

// Export schema for use in queries
export * from "./schema";

// Export db instance for backward compatibility
export let db: ReturnType<typeof drizzle>;
export let sqlite: Database;

// Initialize database on module load
initializeDatabase().then(({ db: database, sqlite: sqliteDb }) => {
  db = database;
  sqlite = sqliteDb;
}).catch(console.error);