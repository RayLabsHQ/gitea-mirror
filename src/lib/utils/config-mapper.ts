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
import { buildClockCronExpression, normalizeTimezone, parseClockCronExpression } from "@/lib/utils/schedule-utils";

// Use the actual database schema types
type DbGitHubConfig = z.infer<typeof githubConfigSchema>;
type DbGiteaConfig = z.infer<typeof giteaConfigSchema>;
type DbScheduleConfig = z.infer<typeof scheduleConfigSchema>;
type DbCleanupConfig = z.infer<typeof cleanupConfigSchema>;

function normalizeStarredLists(lists: string[] | undefined): string[] {
  if (!Array.isArray(lists)) return [];
  const deduped = new Set<string>();
  for (const list of lists) {
    const trimmed = list.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return [...deduped];
}

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
    starredLists: normalizeStarredLists(githubConfig.starredLists),
    
    // Mirror strategy
    mirrorStrategy: giteaConfig.mirrorStrategy || "preserve",
    defaultOrg: giteaConfig.organization,
    
    // Advanced options
    starredCodeOnly: advancedOptions.starredCodeOnly,
    autoMirrorStarred: advancedOptions.autoMirrorStarred ?? false,
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
    backupStrategy: giteaConfig.backupStrategy || "on-force-push",
    backupBeforeSync: giteaConfig.backupBeforeSync ?? true,
    backupRetentionCount: giteaConfig.backupRetentionCount ?? 5,
    backupRetentionDays: giteaConfig.backupRetentionDays ?? 30,
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
    starredLists: normalizeStarredLists(dbConfig.githubConfig?.starredLists),
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
    backupStrategy: dbConfig.giteaConfig?.backupStrategy ||
      // Respect legacy backupBeforeSync: false → "disabled" mapping on round-trip
      (dbConfig.giteaConfig?.backupBeforeSync === false ? "disabled" : "on-force-push"),
    backupBeforeSync: dbConfig.giteaConfig?.backupBeforeSync ?? true,
    backupRetentionCount: dbConfig.giteaConfig?.backupRetentionCount ?? 5,
    backupRetentionDays: dbConfig.giteaConfig?.backupRetentionDays ?? 30,
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
    autoMirrorStarred: dbConfig.githubConfig?.autoMirrorStarred ?? false,
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

  const baseInterval = typeof base.interval === "string"
    ? base.interval
    : String(base.interval ?? 86400);

  const timezone = normalizeTimezone(
    typeof uiSchedule.timezone === "string"
      ? uiSchedule.timezone
      : base.timezone || "UTC"
  );

  let intervalExpression = baseInterval;

  if (uiSchedule.scheduleMode === "clock") {
    const cronExpression = buildClockCronExpression(
      uiSchedule.startTime || "22:00",
      Number(uiSchedule.clockFrequencyHours || 24)
    );
    if (cronExpression) {
      intervalExpression = cronExpression;
    }
  } else if (typeof uiSchedule.intervalExpression === "string" && uiSchedule.intervalExpression.trim().length > 0) {
    intervalExpression = uiSchedule.intervalExpression.trim();
  } else if (typeof uiSchedule.interval === "number" && Number.isFinite(uiSchedule.interval) && uiSchedule.interval > 0) {
    intervalExpression = String(Math.floor(uiSchedule.interval));
  } else if (typeof uiSchedule.interval === "string" && uiSchedule.interval.trim().length > 0) {
    intervalExpression = uiSchedule.interval.trim();
  }

  const scheduleChanged = baseInterval !== intervalExpression || normalizeTimezone(base.timezone || "UTC") !== timezone;

  return {
    ...base,
    enabled: !!uiSchedule.enabled,
    interval: intervalExpression,
    timezone,
    nextRun: scheduleChanged ? undefined : base.nextRun,
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
      intervalExpression: "86400",
      scheduleMode: "interval",
      clockFrequencyHours: 24,
      startTime: "22:00",
      timezone: "UTC",
      lastRun: null,
      nextRun: null,
    };
  }

  const intervalExpression = typeof dbSchedule.interval === "string"
    ? dbSchedule.interval
    : String(dbSchedule.interval ?? 86400);
  const parsedClockSchedule = parseClockCronExpression(intervalExpression);

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
    intervalExpression,
    scheduleMode: parsedClockSchedule ? "clock" : "interval",
    clockFrequencyHours: parsedClockSchedule?.frequencyHours ?? 24,
    startTime: parsedClockSchedule?.startTime ?? "22:00",
    timezone: normalizeTimezone(dbSchedule.timezone || "UTC"),
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
