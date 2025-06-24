#!/usr/bin/env bun
/**
 * Run Drizzle migrations
 */

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ENV } from "@/lib/config";
import path from "path";
import fs from "fs";

const dbPath = ENV.DATABASE_URL.replace("file:", "");

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

console.log("🔄 Running database migrations...");

try {
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  
  // Run migrations
  await migrate(db, { migrationsFolder: "./drizzle" });
  
  console.log("✅ Migrations completed successfully");
  sqlite.close();
} catch (error) {
  console.error("❌ Migration failed:", error);
  process.exit(1);
}