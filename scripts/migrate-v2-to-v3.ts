#!/usr/bin/env bun
/**
 * Migration script from v2.x to v3.0.0
 * This script prepares a v2.x database for Drizzle migrations
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import fs from "fs";
import path from "path";

const MIGRATION_TABLE = "__drizzle_migrations";

// Parse command line arguments
const args = process.argv.slice(2);
const dbPath = args[0] || process.env.DATABASE_URL?.replace("file:", "") || "data/gitea-mirror.db";

if (!fs.existsSync(dbPath)) {
  console.error("❌ Database file not found:", dbPath);
  console.log("Usage: bun scripts/migrate-v2-to-v3.ts [database-path]");
  process.exit(1);
}

console.log("🔄 Migrating Gitea Mirror v2.x database to v3.0.0...");
console.log("📁 Database:", dbPath);

// Create backup
const backupPath = `${dbPath}.v2-backup-${Date.now()}`;
console.log("📦 Creating backup:", backupPath);
fs.copyFileSync(dbPath, backupPath);

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

try {
  // Check if already migrated
  const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  if (tables.some(t => t.name === MIGRATION_TABLE)) {
    console.log("✅ Database already migrated to v3 format");
    process.exit(0);
  }
  
  // Verify this is a v2.x database
  const hasUsersTable = tables.some(t => t.name === "users");
  if (!hasUsersTable) {
    console.error("❌ This doesn't appear to be a valid Gitea Mirror database");
    process.exit(1);
  }
  
  console.log("📊 Found v2.x database with tables:", tables.map(t => t.name).join(", "));
  
  // Check for any missing columns that v3 expects
  console.log("🔍 Checking database structure...");
  
  // Check users table columns
  const userColumns = sqlite.query("PRAGMA table_info(users)").all() as { name: string }[];
  const userColumnNames = userColumns.map(c => c.name);
  
  const requiredUserColumns = [
    "display_name",
    "auth_provider", 
    "external_id",
    "external_username",
    "is_active",
    "last_login_at"
  ];
  
  const missingUserColumns = requiredUserColumns.filter(col => !userColumnNames.includes(col));
  if (missingUserColumns.length > 0) {
    console.log("⚠️  Missing user columns:", missingUserColumns.join(", "));
    console.log("   These should have been added by v2.19.x migrations");
    console.log("   Please ensure you're on v2.19.1 before upgrading to v3.0.0");
    process.exit(1);
  }
  
  // Check if auth_config exists
  const hasAuthConfig = tables.some(t => t.name === "auth_config");
  if (!hasAuthConfig) {
    console.log("⚠️  Missing auth_config table");
    console.log("   This should have been added by v2.19.x");
    console.log("   Please ensure you're on v2.19.1 before upgrading to v3.0.0");
    process.exit(1);
  }
  
  // Mark as ready for v3 migrations
  console.log("✅ Database structure verified");
  console.log("🚀 Ready to apply v3.0.0 migrations");
  
  // The actual schema migration will be handled by Drizzle
  // We just needed to verify the database is in the right state
  
  console.log("\n📋 Next steps:");
  console.log("1. Stop Gitea Mirror if it's running");
  console.log("2. Update to v3.0.0");
  console.log("3. Start Gitea Mirror - migrations will run automatically");
  console.log("\n💾 Backup saved to:", backupPath);
  
} catch (error) {
  console.error("❌ Migration preparation failed:", error);
  console.log("💾 Your database backup is at:", backupPath);
  process.exit(1);
} finally {
  sqlite.close();
}

console.log("✅ Database prepared for v3.0.0 migration");