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
  ssoProviders
} from "./schema";
