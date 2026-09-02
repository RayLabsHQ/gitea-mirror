import { type Config as ConfigType } from "@/lib/db/schema";

export type GiteaOrgVisibility = "public" | "private" | "limited";
export type MirrorStrategy = "preserve" | "single-org" | "flat-user" | "mixed";
export type StarredReposMode = "dedicated-org" | "preserve-owner";
export type BackupStrategy = "disabled" | "always" | "on-force-push" | "block-on-force-push";
export type ScheduleMode = "interval" | "clock";
/** Which host repositories are pulled from. "gitea" also covers Forgejo. */
export type SourceProvider = "github" | "gitlab" | "gitea";
/** Which host repositories are mirrored into. Same API, different label. */
export type DestinationProvider = "gitea" | "forgejo";

export interface GiteaConfig {
  /** Defaults to "gitea" when absent. */
  provider?: DestinationProvider;
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
  autoMirror?: boolean;
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
  /** Defaults to "github" when absent. */
  provider?: SourceProvider;
  /** Instance base URL for GitLab and Gitea sources. */
  url?: string;
  username: string;
  token: string;
  privateRepositories: boolean;
  includeCollaboratorRepos?: boolean;
  includeOrganizations?: string[];
  mirrorStarred: boolean;
  starredLists?: string[];
  starredDuplicateStrategy?: DuplicateNameStrategy;
  starredReposMode?: StarredReposMode;
}

export interface MirrorOptions {
  mirrorReleases: boolean;
  releaseLimit?: number;  // Limit number of releases to mirror (default: 10)
  releaseAssetLimit?: number | null;  // Upload assets only for the newest N releases; null or absent means all, 0 means none
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
  skipPersonalRepos?: boolean;
}

/**
 * Whether the source and destination may still be changed freely. Once
 * repositories have been imported the source is locked, and once anything
 * has been mirrored the destination is locked; a change then needs the
 * matching confirm flag on the save request.
 */
export interface ConfigLockState {
  source: { locked: boolean; repositoryCount: number };
  destination: { locked: boolean; mirroredCount: number };
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
  /** Required to change a locked source (provider or instance URL). */
  confirmSourceChange?: boolean;
  /** Required to change a locked destination (Gitea server URL). */
  confirmDestinationChange?: boolean;
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

export interface GotifyConfig {
  url: string;
  token: string;
  priority: number;
}

export interface WebhookConfig {
  url: string;
  secret?: string;
}

export interface NotificationConfig {
  enabled: boolean;
  provider: "ntfy" | "apprise" | "gotify" | "webhook";
  notifyOnSyncError: boolean;
  notifyOnSyncSuccess: boolean;
  notifyOnNewRepo: boolean;
  ntfy?: NtfyConfig;
  apprise?: AppriseConfig;
  gotify?: GotifyConfig;
  webhook?: WebhookConfig;
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
  locks?: ConfigLockState;
  error?: string;
}
