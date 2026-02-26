import { db, configs } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { encrypt } from "@/lib/utils/encryption";

export interface DefaultConfigOptions {
  userId: string;
  envOverrides?: {
    githubToken?: string;
    githubUsername?: string;
    giteaUrl?: string;
    giteaExternalUrl?: string;
    giteaToken?: string;
    giteaUsername?: string;
    scheduleEnabled?: boolean;
    scheduleInterval?: number;
    cleanupEnabled?: boolean;
    cleanupRetentionDays?: number;
  };
}

/**
 * Creates a default configuration for a new user with sensible defaults
 * Environment variables can override these defaults
 */
export async function createDefaultConfig({ userId, envOverrides = {} }: DefaultConfigOptions) {
  // Check if config already exists
  const existingConfig = await db
    .select()
    .from(configs)
    .where(eq(configs.userId, userId))
    .limit(1);

  if (existingConfig.length > 0) {
    return existingConfig[0];
  }

  // Read environment variables for overrides
  const githubToken = envOverrides.githubToken || process.env.GITHUB_TOKEN || "";
  const githubUsername = envOverrides.githubUsername || process.env.GITHUB_USERNAME || "";
  const giteaUrl = envOverrides.giteaUrl || process.env.GITEA_URL || "";
  const giteaExternalUrl =
    envOverrides.giteaExternalUrl || process.env.GITEA_EXTERNAL_URL || "";
  const giteaToken = envOverrides.giteaToken || process.env.GITEA_TOKEN || "";
  const giteaUsername = envOverrides.giteaUsername || process.env.GITEA_USERNAME || "";
  
  // Schedule config from env - default to ENABLED
  const scheduleEnabled = envOverrides.scheduleEnabled ?? 
    (process.env.SCHEDULE_ENABLED === "false" ? false : true); // Default: ENABLED
  const scheduleInterval = envOverrides.scheduleInterval ?? 
    (process.env.SCHEDULE_INTERVAL ? parseInt(process.env.SCHEDULE_INTERVAL, 10) : 86400); // Default: daily
  
  // Cleanup config from env - default to ENABLED
  const cleanupEnabled = envOverrides.cleanupEnabled ?? 
    (process.env.CLEANUP_ENABLED === "false" ? false : true); // Default: ENABLED
  const cleanupRetentionDays = envOverrides.cleanupRetentionDays ?? 
    (process.env.CLEANUP_RETENTION_DAYS ? parseInt(process.env.CLEANUP_RETENTION_DAYS, 10) * 86400 : 604800); // Default: 7 days

  // Create default configuration
  const configId = uuidv4();
  const defaultConfig = {
    id: configId,
    userId,
    name: "Default Configuration",
    isActive: true,
    githubConfig: {
      owner: githubUsername,
      type: "personal",
      token: githubToken ? encrypt(githubToken) : "",
      includeStarred: false,
      includeForks: true,
      includeArchived: false,
      includePrivate: false,
      includePublic: true,
      includeOrganizations: [],
      starredReposOrg: "starred",
      starredReposMode: "dedicated-org",
      mirrorStrategy: "preserve",
      defaultOrg: "github-mirrors",
    },
    giteaConfig: {
      url: giteaUrl,
      externalUrl: giteaExternalUrl || undefined,
      token: giteaToken ? encrypt(giteaToken) : "",
      defaultOwner: giteaUsername,
      mirrorInterval: "8h",
      lfs: false,
      wiki: false,
      visibility: "public",
      createOrg: true,
      addTopics: true,
      preserveVisibility: false,
      forkStrategy: "reference",
      issueConcurrency: 3,
      pullRequestConcurrency: 5,
      backupBeforeSync: true,
      backupRetentionCount: 20,
      backupDirectory: "data/repo-backups",
      blockSyncOnBackupFailure: true,
    },
    include: [],
    exclude: [],
    scheduleConfig: {
      enabled: scheduleEnabled,
      interval: scheduleInterval,
      concurrent: false,
      batchSize: 5, // Reduced from 10 to be more conservative with GitHub API limits
      lastRun: null,
      nextRun: scheduleEnabled ? new Date(Date.now() + scheduleInterval * 1000) : null,
    },
    cleanupConfig: {
      enabled: cleanupEnabled,
      retentionDays: cleanupRetentionDays,
      deleteFromGitea: false,
      deleteIfNotInGitHub: true,
      protectedRepos: [],
      dryRun: false,
      orphanedRepoAction: "archive",
      batchSize: 10,
      pauseBetweenDeletes: 2000,
      lastRun: null,
      nextRun: cleanupEnabled ? new Date(Date.now() + getCleanupInterval(cleanupRetentionDays) * 1000) : null,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Insert the default config
  await db.insert(configs).values(defaultConfig);

  return defaultConfig;
}

/**
 * Calculate cleanup interval based on retention period
 */
function getCleanupInterval(retentionSeconds: number): number {
  const days = retentionSeconds / 86400;
  if (days <= 1) return 21600; // 6 hours
  if (days <= 3) return 43200; // 12 hours
  if (days <= 7) return 86400; // 24 hours
  if (days <= 30) return 172800; // 48 hours
  return 604800; // 1 week
}
