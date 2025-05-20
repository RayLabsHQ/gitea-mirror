import { z } from "zod";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import path from "path";
import { configSchema } from "./schema";

// Define the database URL - for development we'll use a local SQLite file
const dataDir = path.join(process.cwd(), "data");
const dbUrl =
  process.env.DATABASE_URL || `file:${path.join(dataDir, "gitea-mirror.db")}`;

// Create a SQLite database instance using Bun's native driver
export const sqlite = new Database(dbUrl);

// Simple async wrapper around Bun's SQLite API for compatibility
export const client = {
  async execute(sql: string, params?: any[]) {
    const stmt = sqlite.query(sql);
    if (/^\s*select/i.test(sql)) {
      const rows = stmt.all(params ?? []);
      return { rows } as { rows: any[] };
    }
    stmt.run(params ?? []);
    return { rows: [] } as { rows: any[] };
  },
};

// Create a drizzle instance
export const db = drizzle(sqlite);

// Define the tables
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  password: text("password").notNull(),
  email: text("email").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(new Date()),
});

const githubSchema = configSchema.shape.githubConfig;
const giteaSchema = configSchema.shape.giteaConfig;
const scheduleSchema = configSchema.shape.scheduleConfig;

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
