import { type Config as ConfigType } from "@/lib/db/schema";

export type GiteaOrgVisibility = "public" | "private" | "limited";
export type MirrorStrategy = "preserve" | "single-org" | "flat-user" | "mixed";
export type StarredReposMode = "dedicated-org" | "preserve-owner";
export type BackupStrategy = "disabled" | "always" | "on-force-push" | "block-on-force-push";
export type ScheduleMode = "interval" | "clock";

export interface GiteaConfig {
  url: string;
  externalUrl?: string;
  username: string;
  token: string;
  organization: string;
  visibility: GiteaOrgVisibility;
  starredReposOrg: string;
  starredReposMode?: StarredReposMode;
  preserveOrgStructure: boolean;
  mirrorStrategy?: MirrorStrategy; // New field for the strategy
  personalReposOrg?: string; // Override destination for personal repos
  issueConcurrency?: number;
  pullRequestConcurrency?: number;
  backupStrategy?: BackupStrategy;
  backupBeforeSync?: boolean; // Deprecated: kept for backward compat, use backupStrategy
  backupRetentionCount?: number;
  backupRetentionDays?: number;
  backupDirectory?: string;
  blockSyncOnBackupFailure?: boolean;
}

export interface ScheduleConfig {
  enabled: boolean;
  interval: number | string;
  intervalExpression?: string;
  scheduleMode?: ScheduleMode;
  clockFrequencyHours?: number;
  startTime?: string;
  timezone?: string;
  lastRun?: Date;
  nextRun?: Date;
}

export interface DatabaseCleanupConfig {
  enabled: boolean;
  retentionDays: number; // Actually stores seconds, but keeping the name for compatibility
  deleteIfNotInGitHub: boolean;
  orphanedRepoAction: "skip" | "archive" | "delete";
  dryRun: boolean;
  deleteFromGitea?: boolean;
  protectedRepos?: string[];
  batchSize?: number;
  pauseBetweenDeletes?: number;
  lastRun?: Date;
  nextRun?: Date;
}

export type DuplicateNameStrategy = "suffix" | "prefix" | "owner-org";

export interface GitHubConfig {
  username: string;
  token: string;
  privateRepositories: boolean;
  mirrorStarred: boolean;
  starredLists?: string[];
  starredDuplicateStrategy?: DuplicateNameStrategy;
  starredReposMode?: StarredReposMode;
}

export interface MirrorOptions {
  mirrorReleases: boolean;
  releaseLimit?: number;  // Limit number of releases to mirror (default: 10)
  mirrorLFS: boolean;  // Mirror Git LFS objects
  mirrorMetadata: boolean;
  metadataComponents: {
    issues: boolean;
    pullRequests: boolean;
    labels: boolean;
    milestones: boolean;
    wiki: boolean;
  };
}

export interface AdvancedOptions {
  skipForks: boolean;
  starredCodeOnly: boolean;
  autoMirrorStarred?: boolean;
}

export interface SaveConfigApiRequest {
  userId: string;
  githubConfig: GitHubConfig;
  giteaConfig: GiteaConfig;
  scheduleConfig: ScheduleConfig;
  cleanupConfig: DatabaseCleanupConfig;
  notificationConfig?: NotificationConfig;
  mirrorOptions?: MirrorOptions;
  advancedOptions?: AdvancedOptions;
}

export interface SaveConfigApiResponse {
  success: boolean;
  message: string;
}

export interface NtfyConfig {
  url: string;
  topic: string;
  token?: string;
  priority: "min" | "low" | "default" | "high" | "urgent";
}

export interface AppriseConfig {
  url: string;
  token: string;
  tag?: string;
}

export interface NotificationConfig {
  enabled: boolean;
  provider: "ntfy" | "apprise";
  notifyOnSyncError: boolean;
  notifyOnSyncSuccess: boolean;
  notifyOnNewRepo: boolean;
  ntfy?: NtfyConfig;
  apprise?: AppriseConfig;
}

export interface Config extends ConfigType {}

export interface ConfigApiRequest {
  userId: string;
}

export interface ConfigApiResponse {
  id: string;
  userId: string;
  name: string;
  isActive: boolean;
  githubConfig: GitHubConfig;
  giteaConfig: GiteaConfig;
  scheduleConfig: ScheduleConfig;
  cleanupConfig: DatabaseCleanupConfig;
  notificationConfig?: NotificationConfig;
  mirrorOptions?: MirrorOptions;
  advancedOptions?: AdvancedOptions;
  include: string[];
  exclude: string[];
  createdAt: Date;
  updatedAt: Date;
  error?: string;
}
