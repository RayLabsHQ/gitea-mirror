import { z } from "zod";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "fs";
import path from "path";
import { configSchema } from "./schema";

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

  // Ensure all required tables exist
  ensureTablesExist(sqlite);

  // Run migrations
  runMigrations(sqlite);
} catch (error) {
  console.error("Error opening database:", error);
  throw error;
}

/**
 * Run database migrations
 */
function runMigrations(db: Database) {
  try {
    // Migration 1: Add destination_org column to organizations table
    const orgTableInfo = db.query("PRAGMA table_info(organizations)").all() as Array<{name: string}>;
    const hasDestinationOrg = orgTableInfo.some(col => col.name === 'destination_org');

    if (!hasDestinationOrg) {
      console.log("🔄 Running migration: Adding destination_org column to organizations table");
      db.exec("ALTER TABLE organizations ADD COLUMN destination_org TEXT");
      console.log("✅ Migration completed: destination_org column added");
    }

    // Migration 2: Add destination_org column to repositories table
    const repoTableInfo = db.query("PRAGMA table_info(repositories)").all() as Array<{name: string}>;
    const hasRepoDestinationOrg = repoTableInfo.some(col => col.name === 'destination_org');

    if (!hasRepoDestinationOrg) {
      console.log("🔄 Running migration: Adding destination_org column to repositories table");
      db.exec("ALTER TABLE repositories ADD COLUMN destination_org TEXT");
      console.log("✅ Migration completed: destination_org column added to repositories");
    }
  } catch (error) {
    console.error("❌ Error running migrations:", error);
    // Don't throw - migrations should be non-breaking
  }
}

/**
 * Ensure all required tables exist in the database
 */
function ensureTablesExist(db: Database) {
  const requiredTables = [
    "users",
    "configs",
    "repositories",
    "organizations",
    "mirror_jobs",
    "events",
  ];

  for (const table of requiredTables) {
    try {
      // Check if table exists
      const result = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get();

      if (!result) {
        console.warn(`⚠️  Table '${table}' is missing. Creating it now...`);
        createTable(db, table);
        console.log(`✅ Table '${table}' created successfully`);
      }
    } catch (error) {
      console.error(`❌ Error checking/creating table '${table}':`, error);
      throw error;
    }
  }
}

/**
 * Create a specific table with its schema
 */
function createTable(db: Database, tableName: string) {
  switch (tableName) {
    case "users":
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          password TEXT NOT NULL,
          email TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      break;

    case "configs":
      db.exec(`
        CREATE TABLE configs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          github_config TEXT NOT NULL,
          gitea_config TEXT NOT NULL,
          include TEXT NOT NULL DEFAULT '["*"]',
          exclude TEXT NOT NULL DEFAULT '[]',
          schedule_config TEXT NOT NULL,
          cleanup_config TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
      break;

    case "repositories":
      db.exec(`
        CREATE TABLE repositories (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          config_id TEXT NOT NULL,
          name TEXT NOT NULL,
          full_name TEXT NOT NULL,
          url TEXT NOT NULL,
          clone_url TEXT NOT NULL,
          owner TEXT NOT NULL,
          organization TEXT,
          mirrored_location TEXT DEFAULT '',
          is_private INTEGER NOT NULL DEFAULT 0,
          is_fork INTEGER NOT NULL DEFAULT 0,
          forked_from TEXT,
          has_issues INTEGER NOT NULL DEFAULT 0,
          is_starred INTEGER NOT NULL DEFAULT 0,
          language TEXT,
          description TEXT,
          default_branch TEXT NOT NULL,
          visibility TEXT NOT NULL DEFAULT 'public',
          status TEXT NOT NULL DEFAULT 'imported',
          last_mirrored INTEGER,
          error_message TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (config_id) REFERENCES configs(id)
        )
      `);

      // Create indexes for repositories
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_repositories_user_id ON repositories(user_id);
        CREATE INDEX IF NOT EXISTS idx_repositories_config_id ON repositories(config_id);
        CREATE INDEX IF NOT EXISTS idx_repositories_status ON repositories(status);
        CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories(owner);
        CREATE INDEX IF NOT EXISTS idx_repositories_organization ON repositories(organization);
        CREATE INDEX IF NOT EXISTS idx_repositories_is_fork ON repositories(is_fork);
        CREATE INDEX IF NOT EXISTS idx_repositories_is_starred ON repositories(is_starred);
      `);
      break;

    case "organizations":
      db.exec(`
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          config_id TEXT NOT NULL,
          name TEXT NOT NULL,
          avatar_url TEXT NOT NULL,
          membership_role TEXT NOT NULL DEFAULT 'member',
          is_included INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'imported',
          last_mirrored INTEGER,
          error_message TEXT,
          repository_count INTEGER NOT NULL DEFAULT 0,
          destination_org TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (config_id) REFERENCES configs(id)
        )
      `);

      // Create indexes for organizations
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_organizations_user_id ON organizations(user_id);
        CREATE INDEX IF NOT EXISTS idx_organizations_config_id ON organizations(config_id);
        CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
        CREATE INDEX IF NOT EXISTS idx_organizations_is_included ON organizations(is_included);
      `);
      break;

    case "mirror_jobs":
      db.exec(`
        CREATE TABLE mirror_jobs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          repository_id TEXT,
          repository_name TEXT,
          organization_id TEXT,
          organization_name TEXT,
          details TEXT,
          status TEXT NOT NULL DEFAULT 'imported',
          message TEXT NOT NULL,
          timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

          -- New fields for job resilience
          job_type TEXT NOT NULL DEFAULT 'mirror',
          batch_id TEXT,
          total_items INTEGER,
          completed_items INTEGER DEFAULT 0,
          item_ids TEXT, -- JSON array as text
          completed_item_ids TEXT DEFAULT '[]', -- JSON array as text
          in_progress INTEGER NOT NULL DEFAULT 0, -- Boolean as integer
          started_at TIMESTAMP,
          completed_at TIMESTAMP,
          last_checkpoint TIMESTAMP,

          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // Create indexes for mirror_jobs
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mirror_jobs_user_id ON mirror_jobs(user_id);
        CREATE INDEX IF NOT EXISTS idx_mirror_jobs_batch_id ON mirror_jobs(batch_id);
        CREATE INDEX IF NOT EXISTS idx_mirror_jobs_in_progress ON mirror_jobs(in_progress);
        CREATE INDEX IF NOT EXISTS idx_mirror_jobs_job_type ON mirror_jobs(job_type);
        CREATE INDEX IF NOT EXISTS idx_mirror_jobs_timestamp ON mirror_jobs(timestamp);
      `);
      break;

    case "events":
      db.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          payload TEXT NOT NULL,
          read INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // Create indexes for events
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_user_channel ON events(user_id, channel);
        CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
        CREATE INDEX IF NOT EXISTS idx_events_read ON events(read);
      `);
      break;

    default:
      throw new Error(`Unknown table: ${tableName}`);
  }
}

// Create drizzle instance with the SQLite client
export const db = drizzle({ client: sqlite });

// Simple async wrapper around SQLite API for compatibility
// This maintains backward compatibility with existing code
export const client = {
  async execute(sql: string, params?: any[]) {
    try {
      const stmt = sqlite.query(sql);
      if (/^\s*select/i.test(sql)) {
        const rows = stmt.all(params ?? []);
        return { rows } as { rows: any[] };
      }
      stmt.run(params ?? []);
      return { rows: [] } as { rows: any[] };
    } catch (error) {
      console.error(`Error executing SQL: ${sql}`, error);
      throw error;
    }
  },
};

// Define the tables
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  password: text("password"), // Made optional for external auth
  email: text("email").notNull(),
  displayName: text("display_name"), // Full name from external providers

  // External authentication fields
  authProvider: text("auth_provider").notNull().default("local"), // local, forward, oidc
  externalId: text("external_id"), // ID from external provider
  externalUsername: text("external_username"), // Username from external provider

  // Metadata
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
});

// New table for event notifications (replacing Redis pub/sub)
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  channel: text("channel").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
});

const githubSchema = configSchema.shape.githubConfig;
const giteaSchema = configSchema.shape.giteaConfig;
const scheduleSchema = configSchema.shape.scheduleConfig;
const cleanupSchema = configSchema.shape.cleanupConfig;

export const configs = sqliteTable("configs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),

  githubConfig: text("github_config", { mode: "json" })
    .$type<z.infer<typeof githubSchema>>()
    .notNull(),

  giteaConfig: text("gitea_config", { mode: "json" })
    .$type<z.infer<typeof giteaSchema>>()
    .notNull(),

  include: text("include", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(["*"]),

  exclude: text("exclude", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),

  scheduleConfig: text("schedule_config", { mode: "json" })
    .$type<z.infer<typeof scheduleSchema>>()
    .notNull(),

  cleanupConfig: text("cleanup_config", { mode: "json" })
    .$type<z.infer<typeof cleanupSchema>>()
    .notNull(),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),

  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
});

export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  configId: text("config_id")
    .notNull()
    .references(() => configs.id),
  name: text("name").notNull(),
  fullName: text("full_name").notNull(),
  url: text("url").notNull(),
  cloneUrl: text("clone_url").notNull(),
  owner: text("owner").notNull(),
  organization: text("organization"),
  mirroredLocation: text("mirrored_location").default(""),

  isPrivate: integer("is_private", { mode: "boolean" })
    .notNull()
    .default(false),
  isForked: integer("is_fork", { mode: "boolean" }).notNull().default(false),
  forkedFrom: text("forked_from"),

  hasIssues: integer("has_issues", { mode: "boolean" })
    .notNull()
    .default(false),
  isStarred: integer("is_starred", { mode: "boolean" })
    .notNull()
    .default(false),
  isArchived: integer("is_archived", { mode: "boolean" })
    .notNull()
    .default(false),

  size: integer("size").notNull().default(0),
  hasLFS: integer("has_lfs", { mode: "boolean" }).notNull().default(false),
  hasSubmodules: integer("has_submodules", { mode: "boolean" })
    .notNull()
    .default(false),

  defaultBranch: text("default_branch").notNull(),
  visibility: text("visibility").notNull().default("public"),

  status: text("status").notNull().default("imported"),
  lastMirrored: integer("last_mirrored", { mode: "timestamp" }),
  errorMessage: text("error_message"),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
});

export const mirrorJobs = sqliteTable("mirror_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  repositoryId: text("repository_id"),
  repositoryName: text("repository_name"),
  organizationId: text("organization_id"),
  organizationName: text("organization_name"),
  details: text("details"),
  status: text("status").notNull().default("imported"),
  message: text("message").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" })
    .notNull()
    .default(new Date()),

  // New fields for job resilience
  jobType: text("job_type").notNull().default("mirror"),
  batchId: text("batch_id"),
  totalItems: integer("total_items"),
  completedItems: integer("completed_items").default(0),
  itemIds: text("item_ids", { mode: "json" }).$type<string[]>(),
  completedItemIds: text("completed_item_ids", { mode: "json" }).$type<string[]>().default([]),
  inProgress: integer("in_progress", { mode: "boolean" }).notNull().default(false),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  lastCheckpoint: integer("last_checkpoint", { mode: "timestamp" }),
});

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  configId: text("config_id")
    .notNull()
    .references(() => configs.id),
  name: text("name").notNull(),

  avatarUrl: text("avatar_url").notNull(),

  membershipRole: text("membership_role").notNull().default("member"),

  isIncluded: integer("is_included", { mode: "boolean" })
    .notNull()
    .default(true),

  // Override destination organization for this GitHub org's repos
  destinationOrg: text("destination_org"),

  status: text("status").notNull().default("imported"),
  lastMirrored: integer("last_mirrored", { mode: "timestamp" }),
  errorMessage: text("error_message"),

  repositoryCount: integer("repository_count").notNull().default(0),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
});
