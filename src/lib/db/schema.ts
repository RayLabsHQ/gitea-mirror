// Complete Drizzle schema definition for Gitea Mirror v3.0.0
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ============================================
// USERS TABLE
// ============================================
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  password: text("password"), // Optional for external auth
  email: text("email").notNull(),
  displayName: text("display_name"),
  
  // Authentication fields
  authProvider: text("auth_provider").notNull().default("local"),
  externalId: text("external_id"),
  externalUsername: text("external_username"),
  
  // Status fields
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  
  // Timestamps
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => {
  return {
    usernameIdx: uniqueIndex("idx_users_username").on(table.username),
    emailIdx: index("idx_users_email").on(table.email),
    authProviderIdx: index("idx_users_auth_provider").on(table.authProvider),
    externalIdIdx: index("idx_users_external_id").on(table.externalId),
  };
});

// ============================================
// AUTH CONFIG TABLE
// ============================================
export const authConfig = sqliteTable("auth_config", {
  id: text("id").primaryKey(),
  
  // Auth method configuration
  method: text("method").notNull().default("local"), // local, oidc, forward
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  allowLocalFallback: integer("allow_local_fallback", { mode: "boolean" }).notNull().default(false),
  
  // Configuration as JSON
  forwardAuth: text("forward_auth", { mode: "json" }).$type<{
    userHeader: string;
    emailHeader: string;
    nameHeader?: string;
    trustedProxies: string[];
    autoCreateUsers: boolean;
  }>(),
  
  oidc: text("oidc", { mode: "json" }).$type<{
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
    scopes: string[];
    autoCreateUsers: boolean;
    allowedDomains?: string[];
  }>(),
  
  // Timestamps
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ============================================
// CONFIGS TABLE
// ============================================
export const configs = sqliteTable("configs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  
  // Configuration as JSON
  githubConfig: text("github_config", { mode: "json" }).notNull().$type<{
    token: string;
    baseUrl?: string;
    includeStarred: boolean;
    includeWatched: boolean;
    includeForks: boolean;
    includeArchived: boolean;
    includePrivate: boolean;
    includePublic: boolean;
    selectedOrgs: string[];
  }>(),
  
  giteaConfig: text("gitea_config", { mode: "json" }).notNull().$type<{
    url: string;
    token: string;
    mirrorInterval: string;
    defaultBranch: string;
    organizationStrategy: string;
    singleOrgName?: string;
    personalReposOrg?: string;
    starredReposOrg?: string;
    includeWiki: boolean;
    includeIssues: boolean;
    includePullRequests: boolean;
    includeReleases: boolean;
    includeMilestones: boolean;
    includeLabels: boolean;
  }>(),
  
  include: text("include", { mode: "json" }).notNull().default(sql`'["*"]'`).$type<string[]>(),
  exclude: text("exclude", { mode: "json" }).notNull().default(sql`'[]'`).$type<string[]>(),
  
  scheduleConfig: text("schedule_config", { mode: "json" }).notNull().$type<{
    enabled: boolean;
    interval: string;
    time?: string;
  }>(),
  
  cleanupConfig: text("cleanup_config", { mode: "json" }).notNull().$type<{
    enabled: boolean;
    keepDays: number;
    keepCount: number;
  }>(),
  
  // Timestamps
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => {
  return {
    userIdIdx: index("idx_configs_user_id").on(table.userId),
    isActiveIdx: index("idx_configs_is_active").on(table.isActive),
  };
});

// ============================================
// REPOSITORIES TABLE
// ============================================
export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  configId: text("config_id").notNull().references(() => configs.id, { onDelete: "cascade" }),
  
  // Repository info
  name: text("name").notNull(),
  fullName: text("full_name").notNull(),
  url: text("url").notNull(),
  cloneUrl: text("clone_url").notNull(),
  owner: text("owner").notNull(),
  organization: text("organization"),
  mirroredLocation: text("mirrored_location").default(""),
  destinationOrg: text("destination_org"), // Custom destination override
  
  // Repository metadata
  isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
  isFork: integer("is_fork", { mode: "boolean" }).notNull().default(false),
  forkedFrom: text("forked_from"),
  hasIssues: integer("has_issues", { mode: "boolean" }).notNull().default(false),
  isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  
  // Additional metadata
  size: integer("size").notNull().default(0),
  hasLFS: integer("has_lfs", { mode: "boolean" }).notNull().default(false),
  hasSubmodules: integer("has_submodules", { mode: "boolean" }).notNull().default(false),
  language: text("language"),
  description: text("description"),
  defaultBranch: text("default_branch").notNull(),
  visibility: text("visibility").notNull().default("public"),
  
  // Status
  status: text("status").notNull().default("imported"),
  lastMirrored: integer("last_mirrored", { mode: "timestamp" }),
  errorMessage: text("error_message"),
  
  // Timestamps
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => {
  return {
    userIdIdx: index("idx_repositories_user_id").on(table.userId),
    configIdIdx: index("idx_repositories_config_id").on(table.configId),
    statusIdx: index("idx_repositories_status").on(table.status),
    ownerIdx: index("idx_repositories_owner").on(table.owner),
    organizationIdx: index("idx_repositories_organization").on(table.organization),
    isForkIdx: index("idx_repositories_is_fork").on(table.isFork),
    isStarredIdx: index("idx_repositories_is_starred").on(table.isStarred),
  };
});

// ============================================
// ORGANIZATIONS TABLE
// ============================================
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  configId: text("config_id").notNull().references(() => configs.id, { onDelete: "cascade" }),
  
  // Organization info
  name: text("name").notNull(),
  avatarUrl: text("avatar_url").notNull(),
  membershipRole: text("membership_role").notNull().default("member"),
  isIncluded: integer("is_included", { mode: "boolean" }).notNull().default(true),
  destinationOrg: text("destination_org"), // Custom destination override
  
  // Status
  status: text("status").notNull().default("imported"),
  lastMirrored: integer("last_mirrored", { mode: "timestamp" }),
  errorMessage: text("error_message"),
  repositoryCount: integer("repository_count").notNull().default(0),
  
  // Timestamps
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => {
  return {
    userIdIdx: index("idx_organizations_user_id").on(table.userId),
    configIdIdx: index("idx_organizations_config_id").on(table.configId),
    statusIdx: index("idx_organizations_status").on(table.status),
    isIncludedIdx: index("idx_organizations_is_included").on(table.isIncluded),
  };
});

// ============================================
// MIRROR JOBS TABLE
// ============================================
export const mirrorJobs = sqliteTable("mirror_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  
  // Job details
  repositoryId: text("repository_id"),
  repositoryName: text("repository_name"),
  organizationId: text("organization_id"),
  organizationName: text("organization_name"),
  details: text("details"),
  
  // Job status
  status: text("status").notNull().default("pending"),
  message: text("message").notNull(),
  
  // Job resilience fields
  jobType: text("job_type").notNull().default("mirror"),
  batchId: text("batch_id"),
  totalItems: integer("total_items"),
  completedItems: integer("completed_items").default(0),
  itemIds: text("item_ids", { mode: "json" }).$type<string[]>(),
  completedItemIds: text("completed_item_ids", { mode: "json" }).default(sql`'[]'`).$type<string[]>(),
  inProgress: integer("in_progress", { mode: "boolean" }).notNull().default(false),
  
  // Timestamps
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  lastCheckpoint: integer("last_checkpoint", { mode: "timestamp" }),
}, (table) => {
  return {
    userIdIdx: index("idx_mirror_jobs_user_id").on(table.userId),
    batchIdIdx: index("idx_mirror_jobs_batch_id").on(table.batchId),
    inProgressIdx: index("idx_mirror_jobs_in_progress").on(table.inProgress),
    jobTypeIdx: index("idx_mirror_jobs_job_type").on(table.jobType),
    timestampIdx: index("idx_mirror_jobs_timestamp").on(table.timestamp),
  };
});

// ============================================
// EVENTS TABLE
// ============================================
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  
  // Event details
  channel: text("channel").notNull(),
  payload: text("payload", { mode: "json" }).notNull().$type<any>(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  
  // Timestamp
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => {
  return {
    userChannelIdx: index("idx_events_user_channel").on(table.userId, table.channel),
    createdAtIdx: index("idx_events_created_at").on(table.createdAt),
    readIdx: index("idx_events_read").on(table.read),
  };
});

// ============================================
// EXPORT ALL TABLES
// ============================================
export const schema = {
  users,
  authConfig,
  configs,
  repositories,
  organizations,
  mirrorJobs,
  events,
};

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthConfig = typeof authConfig.$inferSelect;
export type NewAuthConfig = typeof authConfig.$inferInsert;
export type Config = typeof configs.$inferSelect;
export type NewConfig = typeof configs.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type MirrorJob = typeof mirrorJobs.$inferSelect;
export type NewMirrorJob = typeof mirrorJobs.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;