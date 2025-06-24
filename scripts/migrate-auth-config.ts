#!/usr/bin/env bun
/**
 * Migration script to create auth_config entries for existing installations
 * that upgraded from versions before auth_config was introduced.
 */

import { Database } from "bun:sqlite";
import { v4 as uuidv4 } from "uuid";

const dbPath = process.env.DATABASE_URL?.replace("file:", "") || "data/gitea-mirror.db";

try {
  const db = new Database(dbPath);
  
  // Check if auth_config table exists
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_config'").all();
  if (tables.length === 0) {
    console.log("❌ auth_config table doesn't exist. Please run database initialization first.");
    process.exit(1);
  }
  
  // Check if we have users but no auth config
  const userCount = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number };
  const authConfigCount = db.query("SELECT COUNT(*) as count FROM auth_config").get() as { count: number };
  
  console.log(`Found ${userCount.count} users and ${authConfigCount.count} auth configs`);
  
  if (userCount.count > 0 && authConfigCount.count === 0) {
    console.log("🔄 Migrating existing installation to use auth_config...");
    
    // Check if users have auth_provider column (they should after migration)
    const userColumns = db.query("PRAGMA table_info(users)").all();
    const hasAuthProvider = userColumns.some((col: any) => col.name === "auth_provider");
    
    if (!hasAuthProvider) {
      console.log("❌ Users table is missing auth_provider column. Database migration may have failed.");
      process.exit(1);
    }
    
    // Get the auth method from the first user (should be 'local' for existing installations)
    const firstUser = db.query("SELECT auth_provider FROM users LIMIT 1").get() as { auth_provider: string };
    const authMethod = firstUser?.auth_provider || "local";
    
    console.log(`Detected auth method: ${authMethod}`);
    
    // Create a default auth config for the existing auth method
    const authConfig = {
      id: uuidv4(),
      method: authMethod,
      isActive: 1,
      allowLocalFallback: authMethod === "local" ? 0 : 1, // No fallback needed for local auth
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    const insertQuery = db.prepare(`
      INSERT INTO auth_config (id, method, is_active, allow_local_fallback, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    insertQuery.run(
      authConfig.id,
      authConfig.method,
      authConfig.isActive,
      authConfig.allowLocalFallback,
      authConfig.createdAt,
      authConfig.updatedAt
    );
    
    console.log("✅ Successfully created auth_config for existing installation");
    console.log(`   Method: ${authConfig.method}`);
    console.log(`   Allow local fallback: ${authConfig.allowLocalFallback ? "Yes" : "No"}`);
    
    // Verify the migration
    const newAuthConfigCount = db.query("SELECT COUNT(*) as count FROM auth_config").get() as { count: number };
    console.log(`✅ Auth config count after migration: ${newAuthConfigCount.count}`);
  } else if (authConfigCount.count > 0) {
    console.log("✅ Auth config already exists, no migration needed");
  } else {
    console.log("ℹ️  No users found, this appears to be a fresh installation");
  }
  
  db.close();
  console.log("✅ Migration check completed");
} catch (error) {
  console.error("❌ Migration failed:", error);
  process.exit(1);
}