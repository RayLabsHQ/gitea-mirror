/**
 * Maps between UI config structure and database schema structure
 */

import type { 
  GitHubConfig, 
  GiteaConfig,
  MirrorOptions, 
  AdvancedOptions,
  SaveConfigApiRequest 
} from "@/types/config";
import { z } from "zod";
import { githubConfigSchema, giteaConfigSchema, scheduleConfigSchema, cleanupConfigSchema } from "@/lib/db/schema";
import { parseInterval } from "@/lib/utils/duration-parser";

// Use the actual database schema types
type DbGitHubConfig = z.infer<typeof githubConfigSchema>;
type DbGiteaConfig = z.infer<typeof giteaConfigSchema>;
type DbScheduleConfig = z.infer<typeof scheduleConfigSchema>;
type DbCleanupConfig = z.infer<typeof cleanupConfigSchema>;

/**
 * Maps UI config structure to database schema structure
 */
export function mapUiToDbConfig(
  githubConfig: GitHubConfig,
  giteaConfig: GiteaConfig,
  mirrorOptions: MirrorOptions,
  advancedOptions: AdvancedOptions
): { githubConfig: DbGitHubConfig; giteaConfig: DbGiteaConfig } {
  // Map GitHub config to match database schema fields
  const dbGithubConfig: DbGitHubConfig = {
    // Map username to owner field
    owner: githubConfig.username,
    type: "personal", // Default to personal, could be made configurable
    token: githubConfig.token || "",
    
    // Map checkbox fields with proper names
    includeStarred: githubConfig.mirrorStarred,
    includePrivate: githubConfig.privateRepositories,
    includeForks: !advancedOptions.skipForks, // Note: UI has skipForks, DB has includeForks
    skipForks: advancedOptions.skipForks, // Add skipForks field
    includeArchived: false, // Not in UI yet, default to false
    includePublic: true, // Not in UI yet, default to true
    
    // Organization related fields
    includeOrganizations: [], // Not in UI yet
    
    // Starred repos organization
    starredReposOrg: giteaConfig.starredReposOrg,
    starredReposMode: giteaConfig.starredReposMode || "dedicated-org",
    
    // Mirror strategy
    mirrorStrategy: giteaConfig.mirrorStrategy || "preserve",
    defaultOrg: giteaConfig.organization,
    
    // Advanced options
    starredCodeOnly: advancedOptions.starredCodeOnly,
  };

  // Map Gitea config to match database schema
  const dbGiteaConfig: DbGiteaConfig = {
    url: giteaConfig.url,
    externalUrl: giteaConfig.externalUrl?.trim() || undefined,
    token: giteaConfig.token,
    defaultOwner: giteaConfig.username, // Map username to defaultOwner
    organization: giteaConfig.organization, // Add organization field
    preserveOrgStructure: giteaConfig.mirrorStrategy === "preserve" || giteaConfig.mirrorStrategy === "mixed", // Add preserveOrgStructure field
    
    // Mirror interval and options
    mirrorInterval: "8h", // Default value, could be made configurable
    lfs: mirrorOptions.mirrorLFS || false, // LFS mirroring option
    wiki: mirrorOptions.mirrorMetadata && mirrorOptions.metadataComponents.wiki,
    
    // Visibility settings
    visibility: giteaConfig.visibility || "default",
    preserveVisibility: false, // This should be a separate field, not the same as preserveOrgStructure
    
    // Organization creation
    createOrg: true, // Default to true
    
    // Template settings (not in UI yet)
    templateOwner: undefined,
    templateRepo: undefined,
    
    // Topics
    addTopics: true, // Default to true
    topicPrefix: undefined,
    
    // Fork strategy
    forkStrategy: advancedOptions.skipForks ? "skip" : "reference",
    
    // Mirror options from UI
    issueConcurrency: giteaConfig.issueConcurrency ?? 3,
    pullRequestConcurrency: giteaConfig.pullRequestConcurrency ?? 5,
    mirrorReleases: mirrorOptions.mirrorReleases,
    releaseLimit: mirrorOptions.releaseLimit || 10,
    mirrorMetadata: mirrorOptions.mirrorMetadata,
    mirrorIssues: mirrorOptions.mirrorMetadata && mirrorOptions.metadataComponents.issues,
    mirrorPullRequests: mirrorOptions.mirrorMetadata && mirrorOptions.metadataComponents.pullRequests,
    mirrorLabels: mirrorOptions.mirrorMetadata && mirrorOptions.metadataComponents.labels,
    mirrorMilestones: mirrorOptions.mirrorMetadata && mirrorOptions.metadataComponents.milestones,
    backupBeforeSync: giteaConfig.backupBeforeSync ?? true,
    backupRetentionCount: giteaConfig.backupRetentionCount ?? 20,
    backupDirectory: giteaConfig.backupDirectory?.trim() || undefined,
    blockSyncOnBackupFailure: giteaConfig.blockSyncOnBackupFailure ?? true,
  };

  return {
    githubConfig: dbGithubConfig,
    giteaConfig: dbGiteaConfig,
  };
}

/**
 * Maps database schema structure to UI config structure
 */
export function mapDbToUiConfig(dbConfig: any): {
  githubConfig: GitHubConfig;
  giteaConfig: GiteaConfig;
  mirrorOptions: MirrorOptions;
  advancedOptions: AdvancedOptions;
} {
  // Map from database GitHub config to UI fields
  const githubConfig: GitHubConfig = {
    username: dbConfig.githubConfig?.owner || "", // Map owner to username
    token: dbConfig.githubConfig?.token || "",
    privateRepositories: dbConfig.githubConfig?.includePrivate || false, // Map includePrivate to privateRepositories
    mirrorStarred: dbConfig.githubConfig?.includeStarred || false, // Map includeStarred to mirrorStarred
  };

  // Map from database Gitea config to UI fields
  const giteaConfig: GiteaConfig = {
    url: dbConfig.giteaConfig?.url || "",
    externalUrl: dbConfig.giteaConfig?.externalUrl || "",
    username: dbConfig.giteaConfig?.defaultOwner || "", // Map defaultOwner to username
    token: dbConfig.giteaConfig?.token || "",
    organization: dbConfig.githubConfig?.defaultOrg || "github-mirrors", // Get from GitHub config
    visibility: dbConfig.giteaConfig?.visibility === "default" ? "public" : dbConfig.giteaConfig?.visibility || "public",
    starredReposOrg: dbConfig.githubConfig?.starredReposOrg || "starred", // Get from GitHub config
    starredReposMode: dbConfig.githubConfig?.starredReposMode || "dedicated-org", // Get from GitHub config
    preserveOrgStructure: dbConfig.giteaConfig?.preserveVisibility || false, // Map preserveVisibility
    mirrorStrategy: dbConfig.githubConfig?.mirrorStrategy || "preserve", // Get from GitHub config
    personalReposOrg: undefined, // Not stored in current schema
    issueConcurrency: dbConfig.giteaConfig?.issueConcurrency ?? 3,
    pullRequestConcurrency: dbConfig.giteaConfig?.pullRequestConcurrency ?? 5,
    backupBeforeSync: dbConfig.giteaConfig?.backupBeforeSync ?? true,
    backupRetentionCount: dbConfig.giteaConfig?.backupRetentionCount ?? 20,
    backupDirectory: dbConfig.giteaConfig?.backupDirectory || "data/repo-backups",
    blockSyncOnBackupFailure: dbConfig.giteaConfig?.blockSyncOnBackupFailure ?? true,
  };

  // Map mirror options from various database fields
  const mirrorOptions: MirrorOptions = {
    mirrorReleases: dbConfig.giteaConfig?.mirrorReleases || false,
    releaseLimit: dbConfig.giteaConfig?.releaseLimit || 10,
    mirrorLFS: dbConfig.giteaConfig?.lfs || false,
    mirrorMetadata: dbConfig.giteaConfig?.mirrorMetadata || false,
    metadataComponents: {
      issues: dbConfig.giteaConfig?.mirrorIssues || false,
      pullRequests: dbConfig.giteaConfig?.mirrorPullRequests || false,
      labels: dbConfig.giteaConfig?.mirrorLabels || false,
      milestones: dbConfig.giteaConfig?.mirrorMilestones || false,
      wiki: dbConfig.giteaConfig?.wiki || false,
    },
  };

  // Map advanced options
  const advancedOptions: AdvancedOptions = {
    skipForks: !(dbConfig.githubConfig?.includeForks ?? true), // Invert includeForks to get skipForks
    // Support both old (skipStarredIssues) and new (starredCodeOnly) field names for backward compatibility
    starredCodeOnly: dbConfig.githubConfig?.starredCodeOnly ?? (dbConfig.githubConfig as any)?.skipStarredIssues ?? false,
  };

  return {
    githubConfig,
    giteaConfig,
    mirrorOptions,
    advancedOptions,
  };
}

/**
 * Maps UI schedule config to database schema
 */
export function mapUiScheduleToDb(uiSchedule: any, existing?: DbScheduleConfig): DbScheduleConfig {
  // Preserve existing schedule config and only update fields controlled by the UI
  const base: DbScheduleConfig = existing
    ? { ...(existing as unknown as DbScheduleConfig) }
    : (scheduleConfigSchema.parse({}) as unknown as DbScheduleConfig);

  // Store interval as seconds string to avoid lossy cron conversion
  const intervalSeconds = typeof uiSchedule.interval === 'number' && uiSchedule.interval > 0
    ? String(uiSchedule.interval)
    : (typeof base.interval === 'string' ? base.interval : String(86400));

  return {
    ...base,
    enabled: !!uiSchedule.enabled,
    interval: intervalSeconds,
  } as DbScheduleConfig;
}

/**
 * Maps database schedule config to UI format
 */
export function mapDbScheduleToUi(dbSchedule: DbScheduleConfig): any {
  // Handle null/undefined schedule config
  if (!dbSchedule) {
    return {
      enabled: false,
      interval: 86400, // Default to daily (24 hours)
      lastRun: null,
      nextRun: null,
    };
  }

  // Parse interval supporting numbers (seconds), duration strings, and cron
  let intervalSeconds = 86400; // Default to daily (24 hours)
  try {
    const ms = parseInterval(
      typeof dbSchedule.interval === 'number'
        ? dbSchedule.interval
        : (dbSchedule.interval as unknown as string)
    );
    intervalSeconds = Math.max(1, Math.floor(ms / 1000));
  } catch (_e) {
    // Fallback to default if unparsable
    intervalSeconds = 86400;
  }

  return {
    enabled: dbSchedule.enabled || false,
    interval: intervalSeconds,
    lastRun: dbSchedule.lastRun || null,
    nextRun: dbSchedule.nextRun || null,
  };
}

/**
 * Maps UI cleanup config to database schema
 */
export function mapUiCleanupToDb(uiCleanup: any): DbCleanupConfig {
  const parsedRetention =
    typeof uiCleanup.retentionDays === "string"
      ? parseInt(uiCleanup.retentionDays, 10)
      : uiCleanup.retentionDays;
  const retentionSeconds = Number.isFinite(parsedRetention)
    ? parsedRetention
    : 604800;

  return {
    enabled: Boolean(uiCleanup.enabled),
    retentionDays: retentionSeconds,
    deleteFromGitea: uiCleanup.deleteFromGitea ?? false,
    deleteIfNotInGitHub: uiCleanup.deleteIfNotInGitHub ?? true,
    protectedRepos: uiCleanup.protectedRepos ?? [],
    dryRun: uiCleanup.dryRun ?? false,
    orphanedRepoAction: (uiCleanup.orphanedRepoAction as DbCleanupConfig["orphanedRepoAction"]) || "archive",
    batchSize: uiCleanup.batchSize ?? 10,
    pauseBetweenDeletes: uiCleanup.pauseBetweenDeletes ?? 2000,
    lastRun: uiCleanup.lastRun ?? null,
    nextRun: uiCleanup.nextRun ?? null,
  };
}

/**
 * Maps database cleanup config to UI format
 */
export function mapDbCleanupToUi(dbCleanup: DbCleanupConfig): any {
  // Handle null/undefined cleanup config
  if (!dbCleanup) {
    return {
      enabled: false,
      retentionDays: 604800, // Default to 7 days in seconds
      lastRun: null,
      nextRun: null,
    };
  }

  return {
    enabled: dbCleanup.enabled ?? false,
    retentionDays: dbCleanup.retentionDays ?? 604800,
    deleteFromGitea: dbCleanup.deleteFromGitea ?? false,
    deleteIfNotInGitHub: dbCleanup.deleteIfNotInGitHub ?? true,
    protectedRepos: dbCleanup.protectedRepos ?? [],
    dryRun: dbCleanup.dryRun ?? false,
    orphanedRepoAction: dbCleanup.orphanedRepoAction ?? "archive",
    batchSize: dbCleanup.batchSize ?? 10,
    pauseBetweenDeletes: dbCleanup.pauseBetweenDeletes ?? 2000,
    lastRun: dbCleanup.lastRun ?? null,
    nextRun: dbCleanup.nextRun ?? null,
  };
}
