import { z } from "zod";
import { repositoryVisibilityEnum, repoStatusEnum } from "@/types/Repository";
import { membershipRoleEnum } from "@/types/organizations";

// Authentication provider enum
export const authProviderEnum = z.enum(["local", "forward", "oidc"]);

// User schema
export const userSchema = z.object({
  id: z.string().uuid().optional(),
  username: z.string().min(3),
  password: z.string().min(8).optional(), // Hashed password - optional for external auth
  email: z.string().email(),
  displayName: z.string().optional(), // Full name from external providers

  // External authentication fields
  authProvider: authProviderEnum.default("local"),
  externalId: z.string().optional(), // ID from external provider
  externalUsername: z.string().optional(), // Username from external provider

  // Metadata
  isActive: z.boolean().default(true),
  lastLoginAt: z.date().optional(),

  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),
});

export type User = z.infer<typeof userSchema>;

// Configuration schema
export const configSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid(),
  name: z.string().min(1),
  isActive: z.boolean().default(true),
  githubConfig: z.object({
    username: z.string().min(1),
    token: z.string().optional(),
    skipForks: z.boolean().default(false),
    privateRepositories: z.boolean().default(false),
    mirrorIssues: z.boolean().default(false),
    mirrorWiki: z.boolean().default(false),
    mirrorStarred: z.boolean().default(false),
    useSpecificUser: z.boolean().default(false),
    singleRepo: z.string().optional(),
    includeOrgs: z.array(z.string()).default([]),
    excludeOrgs: z.array(z.string()).default([]),
    mirrorPublicOrgs: z.boolean().default(false),
    publicOrgs: z.array(z.string()).default([]),
    skipStarredIssues: z.boolean().default(false),
  }),
  giteaConfig: z.object({
    username: z.string().min(1),
    url: z.string().url(),
    token: z.string().min(1),
    organization: z.string().optional(),
    visibility: z.enum(["public", "private", "limited"]).default("public"),
    starredReposOrg: z.string().default("github"),
    preserveOrgStructure: z.boolean().default(false),
    mirrorStrategy: z.enum(["preserve", "single-org", "flat-user", "mixed"]).optional(),
    personalReposOrg: z.string().optional(), // Override destination for personal repos
  }),
  include: z.array(z.string()).default(["*"]),
  exclude: z.array(z.string()).default([]),
  scheduleConfig: z.object({
    enabled: z.boolean().default(false),
    interval: z.number().min(1).default(3600), // in seconds
    lastRun: z.date().optional(),
    nextRun: z.date().optional(),
  }),
  cleanupConfig: z.object({
    enabled: z.boolean().default(false),
    retentionDays: z.number().min(1).default(604800), // in seconds (default: 7 days)
    lastRun: z.date().optional(),
    nextRun: z.date().optional(),
  }),
  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),
});

export type Config = z.infer<typeof configSchema>;

// Repository schema
export const repositorySchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  configId: z.string().uuid(),

  name: z.string().min(1),
  fullName: z.string().min(1),
  url: z.string().url(),
  cloneUrl: z.string().url(),

  owner: z.string().min(1),
  organization: z.string().optional(),

  isPrivate: z.boolean().default(false),
  isForked: z.boolean().default(false),
  forkedFrom: z.string().optional(),

  hasIssues: z.boolean().default(false),
  isStarred: z.boolean().default(false),
  isArchived: z.boolean().default(false),

  size: z.number(),
  hasLFS: z.boolean().default(false),
  hasSubmodules: z.boolean().default(false),

  defaultBranch: z.string(),
  visibility: repositoryVisibilityEnum.default("public"),

  status: repoStatusEnum.default("imported"),
  lastMirrored: z.date().optional(),
  errorMessage: z.string().optional(),

  mirroredLocation: z.string().default(""), // Store the full Gitea path where repo was mirrored
  destinationOrg: z.string().optional(), // Custom destination organization override

  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),
});

export type Repository = z.infer<typeof repositorySchema>;

// Mirror job schema
export const mirrorJobSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  repositoryId: z.string().uuid().optional(),
  repositoryName: z.string().optional(),
  organizationId: z.string().uuid().optional(),
  organizationName: z.string().optional(),
  details: z.string().optional(),
  status: repoStatusEnum.default("imported"),
  message: z.string(),
  timestamp: z.date().default(() => new Date()),

  // New fields for job resilience
  jobType: z.enum(["mirror", "sync", "retry"]).default("mirror"),
  batchId: z.string().uuid().optional(), // Group related jobs together
  totalItems: z.number().optional(), // Total number of items to process
  completedItems: z.number().optional(), // Number of items completed
  itemIds: z.array(z.string()).optional(), // IDs of items to process
  completedItemIds: z.array(z.string()).optional(), // IDs of completed items
  inProgress: z.boolean().default(false), // Whether the job is currently running
  startedAt: z.date().optional(), // When the job started
  completedAt: z.date().optional(), // When the job completed
  lastCheckpoint: z.date().optional(), // Last time progress was saved
});

export type MirrorJob = z.infer<typeof mirrorJobSchema>;

// Organization schema
export const organizationSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  configId: z.string().uuid(),

  avatarUrl: z.string().url(),

  name: z.string().min(1),

  membershipRole: membershipRoleEnum.default("member"),

  isIncluded: z.boolean().default(false),

  status: repoStatusEnum.default("imported"),
  lastMirrored: z.date().optional(),
  errorMessage: z.string().optional(),

  repositoryCount: z.number().default(0),
  publicRepositoryCount: z.number().optional(),
  privateRepositoryCount: z.number().optional(),
  forkRepositoryCount: z.number().optional(),

  // Override destination organization for this GitHub org's repos
  destinationOrg: z.string().optional(),

  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),
});

export type Organization = z.infer<typeof organizationSchema>;

// Event schema (for SQLite-based pub/sub)
export const eventSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid(),
  channel: z.string().min(1),
  payload: z.any(),
  read: z.boolean().default(false),
  createdAt: z.date().default(() => new Date()),
});

export type Event = z.infer<typeof eventSchema>;
