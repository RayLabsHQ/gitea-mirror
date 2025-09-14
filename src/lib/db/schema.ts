import { z } from "zod";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ===== Zod Validation Schemas =====
export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  password: z.string(),
  email: z.email(),
  emailVerified: z.boolean().default(false),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const githubConfigSchema = z.object({
  owner: z.string(),
  type: z.enum(["personal", "organization"]),
  token: z.string(),
  includeStarred: z.boolean().default(false),
  includeForks: z.boolean().default(true),
  skipForks: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  includePrivate: z.boolean().default(true),
  includePublic: z.boolean().default(true),
  includeOrganizations: z.array(z.string()).default([]),
  starredReposOrg: z.string().optional(),
  mirrorStrategy: z.enum(["preserve", "single-org", "flat-user", "mixed"]).default("preserve"),
  defaultOrg: z.string().optional(),
  skipStarredIssues: z.boolean().default(false),
  starredDuplicateStrategy: z.enum(["suffix", "prefix", "owner-org"]).default("suffix").optional(),
});

export const giteaConfigSchema = z.object({
  url: z.url(),
  token: z.string(),
  defaultOwner: z.string(),
  organization: z.string().optional(),
  mirrorInterval: z.string().default("8h"),
  lfs: z.boolean().default(false),
  wiki: z.boolean().default(false),
  visibility: z
    .enum(["public", "private", "limited", "default"])
    .default("default"),
  createOrg: z.boolean().default(true),
  templateOwner: z.string().optional(),
  templateRepo: z.string().optional(),
  addTopics: z.boolean().default(true),
  topicPrefix: z.string().optional(),
  preserveVisibility: z.boolean().default(true),
  preserveOrgStructure: z.boolean().default(false),
  forkStrategy: z
    .enum(["skip", "reference", "full-copy"])
    .default("reference"),
  // Mirror options
  mirrorReleases: z.boolean().default(false),
  releaseLimit: z.number().default(10),
  mirrorMetadata: z.boolean().default(false),
  mirrorIssues: z.boolean().default(false),
  mirrorPullRequests: z.boolean().default(false),
  mirrorLabels: z.boolean().default(false),
  mirrorMilestones: z.boolean().default(false),
});

export const scheduleConfigSchema = z.object({
  enabled: z.boolean().default(false),
  interval: z.string().default("0 2 * * *"),
  concurrent: z.boolean().default(false),
  batchSize: z.number().default(10),
  pauseBetweenBatches: z.number().default(5000),
  retryAttempts: z.number().default(3),
  retryDelay: z.number().default(60000),
  timeout: z.number().default(3600000),
  autoRetry: z.boolean().default(true),
  cleanupBeforeMirror: z.boolean().default(false),
  notifyOnFailure: z.boolean().default(true),
  notifyOnSuccess: z.boolean().default(false),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  timezone: z.string().default("UTC"),
  onlyMirrorUpdated: z.boolean().default(false),
  updateInterval: z.number().default(86400000),
  skipRecentlyMirrored: z.boolean().default(true),
  recentThreshold: z.number().default(3600000),
  autoImport: z.boolean().default(true),
  autoMirror: z.boolean().default(false),
  lastRun: z.coerce.date().optional(),
  nextRun: z.coerce.date().optional(),
});

export const cleanupConfigSchema = z.object({
  enabled: z.boolean().default(false),
  retentionDays: z.number().default(604800), // 7 days in seconds
  deleteFromGitea: z.boolean().default(false),
  deleteIfNotInGitHub: z.boolean().default(true),
  protectedRepos: z.array(z.string()).default([]),
  dryRun: z.boolean().default(true),
  orphanedRepoAction: z
    .enum(["skip", "archive", "delete"])
    .default("archive"),
  batchSize: z.number().default(10),
  pauseBetweenDeletes: z.number().default(2000),
  lastRun: z.coerce.date().optional(),
  nextRun: z.coerce.date().optional(),
});

export const configSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  isActive: z.boolean().default(true),
  githubConfig: githubConfigSchema,
  giteaConfig: giteaConfigSchema,
  include: z.array(z.string()).default(["*"]),
  exclude: z.array(z.string()).default([]),
  scheduleConfig: scheduleConfigSchema,
  cleanupConfig: cleanupConfigSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const repositorySchema = z.object({
  id: z.string(),
  userId: z.string(),
  configId: z.string(),
  name: z.string(),
  fullName: z.string(),
  url: z.url(),
  cloneUrl: z.url(),
  owner: z.string(),
  organization: z.string().optional().nullable(),
  mirroredLocation: z.string().default(""),
  isPrivate: z.boolean().default(false),
  isForked: z.boolean().default(false),
  forkedFrom: z.string().optional().nullable(),
  hasIssues: z.boolean().default(false),
  isStarred: z.boolean().default(false),
  isArchived: z.boolean().default(false),
  size: z.number().default(0),
  hasLFS: z.boolean().default(false),
  hasSubmodules: z.boolean().default(false),
  language: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  defaultBranch: z.string(),
  visibility: z.enum(["public", "private", "internal"]).default("public"),
  status: z
    .enum([
      "imported",
      "mirroring",
      "mirrored",
      "failed",
      "skipped",
      "ignored",  // User explicitly wants to ignore this repository
      "deleting",
      "deleted",
      "syncing",
      "synced",
      "archived",
    ])
    .default("imported"),
  lastMirrored: z.coerce.date().optional().nullable(),
  errorMessage: z.string().optional().nullable(),
  destinationOrg: z.string().optional().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const mirrorJobSchema = z.object({
  id: z.string(),
  userId: z.string(),
  repositoryId: z.string().optional().nullable(),
  repositoryName: z.string().optional().nullable(),
  organizationId: z.string().optional().nullable(),
  organizationName: z.string().optional().nullable(),
  details: z.string().optional().nullable(),
  status: z
    .enum([
      "imported",
      "mirroring",
      "mirrored",
      "failed",
      "skipped",
      "ignored",  // User explicitly wants to ignore this repository
      "deleting",
      "deleted",
      "syncing",
      "synced",
      "archived",
    ])
    .default("imported"),
  message: z.string(),
  timestamp: z.coerce.date(),
  jobType: z.enum(["mirror", "cleanup", "import"]).default("mirror"),
  batchId: z.string().optional().nullable(),
  totalItems: z.number().optional().nullable(),
  completedItems: z.number().default(0),
  itemIds: z.array(z.string()).optional().nullable(),
  completedItemIds: z.array(z.string()).default([]),
  inProgress: z.boolean().default(false),
  startedAt: z.coerce.date().optional().nullable(),
  completedAt: z.coerce.date().optional().nullable(),
  lastCheckpoint: z.coerce.date().optional().nullable(),
});

export const organizationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  configId: z.string(),
  name: z.string(),
  avatarUrl: z.string(),
  membershipRole: z.enum(["admin", "member", "owner"]).default("member"),
  isIncluded: z.boolean().default(true),
  destinationOrg: z.string().optional().nullable(),
  status: z
    .enum([
      "imported",
      "mirroring",
      "mirrored",
      "failed",
      "skipped",
      "ignored",  // User explicitly wants to ignore this repository
      "deleting",
      "deleted",
      "syncing",
      "synced",
    ])
    .default("imported"),
  lastMirrored: z.coerce.date().optional().nullable(),
  errorMessage: z.string().optional().nullable(),
  repositoryCount: z.number().default(0),
  publicRepositoryCount: z.number().optional(),
  privateRepositoryCount: z.number().optional(),
  forkRepositoryCount: z.number().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const eventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  channel: z.string(),
  payload: z.any(),
  read: z.boolean().default(false),
  createdAt: z.coerce.date(),
});

// ===== Drizzle Table Definitions =====

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  // Custom fields
  username: text("username"),
}, (_table) => []);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  channel: text("channel").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_events_user_channel").on(table.userId, table.channel),
  index("idx_events_created_at").on(table.createdAt),
  index("idx_events_read").on(table.read),
]);

export const configs = sqliteTable("configs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),

  githubConfig: text("github_config", { mode: "json" })
    .$type<z.infer<typeof githubConfigSchema>>()
    .notNull(),

  giteaConfig: text("gitea_config", { mode: "json" })
    .$type<z.infer<typeof giteaConfigSchema>>()
    .notNull(),

  include: text("include", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'["*"]'`),

  exclude: text("exclude", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),

  scheduleConfig: text("schedule_config", { mode: "json" })
    .$type<z.infer<typeof scheduleConfigSchema>>()
    .notNull(),

  cleanupConfig: text("cleanup_config", { mode: "json" })
    .$type<z.infer<typeof cleanupConfigSchema>>()
    .notNull(),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),

  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (_table) => []);

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

  language: text("language"),
  description: text("description"),
  defaultBranch: text("default_branch").notNull(),
  visibility: text("visibility").notNull().default("public"),

  status: text("status").notNull().default("imported"),
  lastMirrored: integer("last_mirrored", { mode: "timestamp" }),
  errorMessage: text("error_message"),
  
  destinationOrg: text("destination_org"),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_repositories_user_id").on(table.userId),
  index("idx_repositories_config_id").on(table.configId),
  index("idx_repositories_status").on(table.status),
  index("idx_repositories_owner").on(table.owner),
  index("idx_repositories_organization").on(table.organization),
  index("idx_repositories_is_fork").on(table.isForked),
  index("idx_repositories_is_starred").on(table.isStarred),
  uniqueIndex("uniq_repositories_user_full_name").on(table.userId, table.fullName),
]);

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
    .default(sql`(unixepoch())`),

  // Job resilience fields
  jobType: text("job_type").notNull().default("mirror"),
  batchId: text("batch_id"),
  totalItems: integer("total_items"),
  completedItems: integer("completed_items").default(0),
  itemIds: text("item_ids", { mode: "json" }).$type<string[]>(),
  completedItemIds: text("completed_item_ids", { mode: "json" })
    .$type<string[]>()
    .default(sql`'[]'`),
  inProgress: integer("in_progress", { mode: "boolean" })
    .notNull()
    .default(false),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  lastCheckpoint: integer("last_checkpoint", { mode: "timestamp" }),
}, (table) => [
  index("idx_mirror_jobs_user_id").on(table.userId),
  index("idx_mirror_jobs_batch_id").on(table.batchId),
  index("idx_mirror_jobs_in_progress").on(table.inProgress),
  index("idx_mirror_jobs_job_type").on(table.jobType),
  index("idx_mirror_jobs_timestamp").on(table.timestamp),
]);

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

  destinationOrg: text("destination_org"),

  status: text("status").notNull().default("imported"),
  lastMirrored: integer("last_mirrored", { mode: "timestamp" }),
  errorMessage: text("error_message"),

  repositoryCount: integer("repository_count").notNull().default(0),
  publicRepositoryCount: integer("public_repository_count"),
  privateRepositoryCount: integer("private_repository_count"),
  forkRepositoryCount: integer("fork_repository_count"),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_organizations_user_id").on(table.userId),
  index("idx_organizations_config_id").on(table.configId),
  index("idx_organizations_status").on(table.status),
  index("idx_organizations_is_included").on(table.isIncluded),
]);

// ===== Better Auth Tables =====

// Sessions table
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_sessions_user_id").on(table.userId),
  index("idx_sessions_token").on(table.token),
  index("idx_sessions_expires_at").on(table.expiresAt),
]);

// Accounts table (for OAuth providers and credentials)
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(), 
  userId: text("user_id").notNull().references(() => users.id),
  providerId: text("provider_id").notNull(),
  providerUserId: text("provider_user_id"), // Make nullable for email/password auth
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  password: text("password"), // For credential provider
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_accounts_account_id").on(table.accountId),
  index("idx_accounts_user_id").on(table.userId),
  index("idx_accounts_provider").on(table.providerId, table.providerUserId),
]);

// Verification tokens table
export const verificationTokens = sqliteTable("verification_tokens", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  identifier: text("identifier").notNull(),
  type: text("type").notNull(), // email, password-reset, etc
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_verification_tokens_token").on(table.token),
  index("idx_verification_tokens_identifier").on(table.identifier),
]);

// Verifications table (for Better Auth)
export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_verifications_identifier").on(table.identifier),
]);

// ===== OIDC Provider Tables =====

// OAuth Applications table
export const oauthApplications = sqliteTable("oauth_applications", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret").notNull(),
  name: text("name").notNull(),
  redirectURLs: text("redirect_urls").notNull(), // Comma-separated list
  metadata: text("metadata"), // JSON string
  type: text("type").notNull(), // web, mobile, etc
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  userId: text("user_id"), // Optional - owner of the application
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_oauth_applications_client_id").on(table.clientId),
  index("idx_oauth_applications_user_id").on(table.userId),
]);

// OAuth Access Tokens table
export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }).notNull(),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  scopes: text("scopes").notNull(), // Comma-separated list
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_oauth_access_tokens_access_token").on(table.accessToken),
  index("idx_oauth_access_tokens_user_id").on(table.userId),
  index("idx_oauth_access_tokens_client_id").on(table.clientId),
]);

// OAuth Consent table
export const oauthConsent = sqliteTable("oauth_consent", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  clientId: text("client_id").notNull(),
  scopes: text("scopes").notNull(), // Comma-separated list
  consentGiven: integer("consent_given", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_oauth_consent_user_id").on(table.userId),
  index("idx_oauth_consent_client_id").on(table.clientId),
  index("idx_oauth_consent_user_client").on(table.userId, table.clientId),
]);

// ===== SSO Provider Tables =====

// SSO Providers table
export const ssoProviders = sqliteTable("sso_providers", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  domain: text("domain").notNull(),
  oidcConfig: text("oidc_config").notNull(), // JSON string with OIDC configuration
  samlConfig: text("saml_config"), // JSON string with SAML configuration (optional)
  userId: text("user_id").notNull(), // Admin who created this provider
  providerId: text("provider_id").notNull().unique(), // Unique identifier for the provider
  organizationId: text("organization_id"), // Optional - if provider is linked to an organization
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_sso_providers_provider_id").on(table.providerId),
  index("idx_sso_providers_domain").on(table.domain),
  index("idx_sso_providers_issuer").on(table.issuer),
]);

// ===== Rate Limit Tracking =====

export const rateLimitSchema = z.object({
  id: z.string(),
  userId: z.string(),
  provider: z.enum(["github", "gitea"]).default("github"),
  limit: z.number(),
  remaining: z.number(),
  used: z.number(),
  reset: z.coerce.date(),
  retryAfter: z.number().optional(), // seconds to wait
  status: z.enum(["ok", "warning", "limited", "exceeded"]).default("ok"),
  lastChecked: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const rateLimits = sqliteTable("rate_limits", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  provider: text("provider").notNull().default("github"),
  limit: integer("limit").notNull(),
  remaining: integer("remaining").notNull(),
  used: integer("used").notNull(),
  reset: integer("reset", { mode: "timestamp" }).notNull(),
  retryAfter: integer("retry_after"), // seconds to wait
  status: text("status").notNull().default("ok"),
  lastChecked: integer("last_checked", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index("idx_rate_limits_user_provider").on(table.userId, table.provider),
  index("idx_rate_limits_status").on(table.status),
]);

// Export type definitions
export type User = z.infer<typeof userSchema>;
export type Config = z.infer<typeof configSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type MirrorJob = z.infer<typeof mirrorJobSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type Event = z.infer<typeof eventSchema>;
export type RateLimit = z.infer<typeof rateLimitSchema>;
