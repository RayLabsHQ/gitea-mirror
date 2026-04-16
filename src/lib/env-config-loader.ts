/**
 * Environment variable configuration loader
 * Loads configuration from environment variables and populates the database
 */

import { db, configs, users } from '@/lib/db';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { encrypt } from '@/lib/utils/encryption';

interface EnvConfig {
  github: {
    username?: string;
    token?: string;
    type?: 'personal' | 'organization';
    privateRepositories?: boolean;
    publicRepositories?: boolean;
    mirrorStarred?: boolean;
    skipForks?: boolean;
    includeArchived?: boolean;
    mirrorOrganizations?: boolean;
    preserveOrgStructure?: boolean;
    onlyMirrorOrgs?: boolean;
    starredCodeOnly?: boolean;
    autoMirrorStarred?: boolean;
    starredReposOrg?: string;
    starredReposMode?: 'dedicated-org' | 'preserve-owner';
    starredLists?: string[];
    mirrorStrategy?: 'preserve' | 'single-org' | 'flat-user' | 'mixed';
  };
  gitea: {
    url?: string;
    externalUrl?: string;
    username?: string;
    token?: string;
    organization?: string;
    visibility?: 'public' | 'private' | 'limited' | 'default';
    mirrorInterval?: string;
    lfs?: boolean;
    createOrg?: boolean;
    templateOwner?: string;
    templateRepo?: string;
    addTopics?: boolean;
    topicPrefix?: string;
    preserveVisibility?: boolean;
    forkStrategy?: 'skip' | 'reference' | 'full-copy';
  };
  mirror: {
    mirrorIssues?: boolean;
    mirrorWiki?: boolean;
    mirrorReleases?: boolean;
    mirrorPullRequests?: boolean;
    mirrorLabels?: boolean;
    mirrorMilestones?: boolean;
    mirrorMetadata?: boolean;
    releaseLimit?: number;
    issueConcurrency?: number;
    pullRequestConcurrency?: number;
  };
  schedule: {
    enabled?: boolean;
    interval?: string;
    concurrent?: boolean;
    batchSize?: number;
    pauseBetweenBatches?: number;
    retryAttempts?: number;
    retryDelay?: number;
    timeout?: number;
    autoRetry?: boolean;
    cleanupBeforeMirror?: boolean;
    notifyOnFailure?: boolean;
    notifyOnSuccess?: boolean;
    logLevel?: 'error' | 'warn' | 'info' | 'debug';
    timezone?: string;
    onlyMirrorUpdated?: boolean;
    updateInterval?: number;
    skipRecentlyMirrored?: boolean;
    recentThreshold?: number;
    autoImport?: boolean;
    autoMirror?: boolean;
  };
  cleanup: {
    enabled?: boolean;
    retentionDays?: number;
    deleteFromGitea?: boolean;
    deleteIfNotInGitHub?: boolean;
    protectedRepos?: string[];
    dryRun?: boolean;
    orphanedRepoAction?: 'skip' | 'archive' | 'delete';
    batchSize?: number;
    pauseBetweenDeletes?: number;
  };
}

/**
 * Parse environment variables into configuration object
 */
function parseEnvConfig(): EnvConfig {
  // Parse protected repos from comma-separated string
  const protectedRepos = process.env.CLEANUP_PROTECTED_REPOS 
    ? process.env.CLEANUP_PROTECTED_REPOS.split(',').map(r => r.trim()).filter(Boolean)
    : undefined;
  const starredLists = process.env.MIRROR_STARRED_LISTS
    ? process.env.MIRROR_STARRED_LISTS.split(',').map((list) => list.trim()).filter(Boolean)
    : undefined;

  return {
    github: {
      username: process.env.GITHUB_USERNAME,
      token: process.env.GITHUB_TOKEN,
      type: process.env.GITHUB_TYPE as 'personal' | 'organization',
      privateRepositories: process.env.PRIVATE_REPOSITORIES === 'true',
      publicRepositories: process.env.PUBLIC_REPOSITORIES === 'true',
      mirrorStarred: process.env.MIRROR_STARRED === 'true',
      skipForks: process.env.SKIP_FORKS === 'true',
      includeArchived: process.env.INCLUDE_ARCHIVED === 'true',
      mirrorOrganizations: process.env.MIRROR_ORGANIZATIONS === 'true',
      preserveOrgStructure: process.env.PRESERVE_ORG_STRUCTURE === 'true',
      onlyMirrorOrgs: process.env.ONLY_MIRROR_ORGS === 'true',
      starredCodeOnly: process.env.SKIP_STARRED_ISSUES === 'true',
      autoMirrorStarred: process.env.AUTO_MIRROR_STARRED === 'true',
      starredReposOrg: process.env.STARRED_REPOS_ORG,
      starredReposMode: process.env.STARRED_REPOS_MODE as 'dedicated-org' | 'preserve-owner',
      starredLists,
      mirrorStrategy: process.env.MIRROR_STRATEGY as 'preserve' | 'single-org' | 'flat-user' | 'mixed',
    },
    gitea: {
      url: process.env.GITEA_URL,
      externalUrl: process.env.GITEA_EXTERNAL_URL,
      username: process.env.GITEA_USERNAME,
      token: process.env.GITEA_TOKEN,
      organization: process.env.GITEA_ORGANIZATION,
      visibility: process.env.GITEA_ORG_VISIBILITY as 'public' | 'private' | 'limited' | 'default',
      mirrorInterval: process.env.GITEA_MIRROR_INTERVAL,
      lfs: process.env.GITEA_LFS === 'true',
      createOrg: process.env.GITEA_CREATE_ORG === 'true',
      templateOwner: process.env.GITEA_TEMPLATE_OWNER,
      templateRepo: process.env.GITEA_TEMPLATE_REPO,
      addTopics: process.env.GITEA_ADD_TOPICS === 'true',
      topicPrefix: process.env.GITEA_TOPIC_PREFIX,
      preserveVisibility: process.env.GITEA_PRESERVE_VISIBILITY === 'true',
      forkStrategy: process.env.GITEA_FORK_STRATEGY as 'skip' | 'reference' | 'full-copy',
    },
    mirror: {
      mirrorIssues: process.env.MIRROR_ISSUES === 'true',
      mirrorWiki: process.env.MIRROR_WIKI === 'true',
      mirrorReleases: process.env.MIRROR_RELEASES === 'true',
      mirrorPullRequests: process.env.MIRROR_PULL_REQUESTS === 'true',
      mirrorLabels: process.env.MIRROR_LABELS === 'true',
      mirrorMilestones: process.env.MIRROR_MILESTONES === 'true',
      mirrorMetadata: process.env.MIRROR_METADATA === 'true',
      releaseLimit: process.env.RELEASE_LIMIT ? parseInt(process.env.RELEASE_LIMIT, 10) : undefined,
      issueConcurrency: process.env.MIRROR_ISSUE_CONCURRENCY ? parseInt(process.env.MIRROR_ISSUE_CONCURRENCY, 10) : undefined,
      pullRequestConcurrency: process.env.MIRROR_PULL_REQUEST_CONCURRENCY ? parseInt(process.env.MIRROR_PULL_REQUEST_CONCURRENCY, 10) : undefined,
    },
    schedule: {
      enabled: process.env.SCHEDULE_ENABLED === 'true' || 
               !!process.env.GITEA_MIRROR_INTERVAL || 
               !!process.env.SCHEDULE_INTERVAL || 
               !!process.env.DELAY, // Auto-enable if any interval is specified
      interval: process.env.SCHEDULE_INTERVAL || process.env.GITEA_MIRROR_INTERVAL || process.env.DELAY, // Support GITEA_MIRROR_INTERVAL, SCHEDULE_INTERVAL, and old DELAY
      concurrent: process.env.SCHEDULE_CONCURRENT === 'true',
      batchSize: process.env.SCHEDULE_BATCH_SIZE ? parseInt(process.env.SCHEDULE_BATCH_SIZE, 10) : undefined,
      pauseBetweenBatches: process.env.SCHEDULE_PAUSE_BETWEEN_BATCHES ? parseInt(process.env.SCHEDULE_PAUSE_BETWEEN_BATCHES, 10) : undefined,
      retryAttempts: process.env.SCHEDULE_RETRY_ATTEMPTS ? parseInt(process.env.SCHEDULE_RETRY_ATTEMPTS, 10) : undefined,
      retryDelay: process.env.SCHEDULE_RETRY_DELAY ? parseInt(process.env.SCHEDULE_RETRY_DELAY, 10) : undefined,
      timeout: process.env.SCHEDULE_TIMEOUT ? parseInt(process.env.SCHEDULE_TIMEOUT, 10) : undefined,
      autoRetry: process.env.SCHEDULE_AUTO_RETRY === 'true',
      cleanupBeforeMirror: process.env.SCHEDULE_CLEANUP_BEFORE_MIRROR === 'true',
      notifyOnFailure: process.env.SCHEDULE_NOTIFY_ON_FAILURE === 'true',
      notifyOnSuccess: process.env.SCHEDULE_NOTIFY_ON_SUCCESS === 'true',
      logLevel: process.env.SCHEDULE_LOG_LEVEL as 'error' | 'warn' | 'info' | 'debug',
      timezone: process.env.SCHEDULE_TIMEZONE,
      onlyMirrorUpdated: process.env.SCHEDULE_ONLY_MIRROR_UPDATED === 'true',
      updateInterval: process.env.SCHEDULE_UPDATE_INTERVAL ? parseInt(process.env.SCHEDULE_UPDATE_INTERVAL, 10) : undefined,
      skipRecentlyMirrored: process.env.SCHEDULE_SKIP_RECENTLY_MIRRORED === 'true',
      recentThreshold: process.env.SCHEDULE_RECENT_THRESHOLD ? parseInt(process.env.SCHEDULE_RECENT_THRESHOLD, 10) : undefined,
      autoImport: process.env.AUTO_IMPORT_REPOS !== 'false',
      autoMirror: process.env.AUTO_MIRROR_REPOS === 'true',
    },
    cleanup: {
      enabled: process.env.CLEANUP_ENABLED === 'true' || 
               process.env.CLEANUP_DELETE_IF_NOT_IN_GITHUB === 'true', // Auto-enable if deleteIfNotInGitHub is enabled
      retentionDays: process.env.CLEANUP_RETENTION_DAYS ? parseInt(process.env.CLEANUP_RETENTION_DAYS, 10) : undefined,
      deleteFromGitea: process.env.CLEANUP_DELETE_FROM_GITEA === 'true',
      deleteIfNotInGitHub: process.env.CLEANUP_DELETE_IF_NOT_IN_GITHUB === 'true',
      protectedRepos,
      dryRun: process.env.CLEANUP_DRY_RUN === 'true' ? true : process.env.CLEANUP_DRY_RUN === 'false' ? false : false,
      orphanedRepoAction: process.env.CLEANUP_ORPHANED_REPO_ACTION as 'skip' | 'archive' | 'delete',
      batchSize: process.env.CLEANUP_BATCH_SIZE ? parseInt(process.env.CLEANUP_BATCH_SIZE, 10) : undefined,
      pauseBetweenDeletes: process.env.CLEANUP_PAUSE_BETWEEN_DELETES ? parseInt(process.env.CLEANUP_PAUSE_BETWEEN_DELETES, 10) : undefined,
    },
  };
}

/**
 * Check if environment configuration is available
 */
function hasEnvConfig(envConfig: EnvConfig): boolean {
  // Check if any GitHub or Gitea config is provided
  return !!(
    envConfig.github.username ||
    envConfig.github.token ||
    envConfig.gitea.url ||
    envConfig.gitea.username ||
    envConfig.gitea.token
  );
}

/**
 * Initialize configuration from environment variables
 * This function runs on application startup and populates the database
 * with configuration from environment variables if available
 */
export async function initializeConfigFromEnv(): Promise<void> {
  try {
    const envConfig = parseEnvConfig();

    // Skip if no environment config is provided
    if (!hasEnvConfig(envConfig)) {
      console.log('[ENV Config Loader] No environment configuration found, skipping initialization');
      return;
    }

    console.log('[ENV Config Loader] Found environment configuration, initializing...');

    // Get the first user (admin user)
    const firstUser = await db
      .select()
      .from(users)
      .limit(1);

    if (firstUser.length === 0) {
      console.log('[ENV Config Loader] No users found, skipping configuration initialization');
      return;
    }

    const userId = firstUser[0].id;

    // Check if config already exists for this user
    const existingConfig = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    // Determine mirror strategy based on environment variables or use explicit value
    let mirrorStrategy: 'preserve' | 'single-org' | 'flat-user' | 'mixed' = 'preserve';
    if (envConfig.github.mirrorStrategy) {
      mirrorStrategy = envConfig.github.mirrorStrategy;
    } else if (envConfig.github.preserveOrgStructure === false && envConfig.gitea.organization) {
      mirrorStrategy = 'single-org';
    } else if (envConfig.github.preserveOrgStructure === true) {
      mirrorStrategy = 'preserve';
    }

    // Build GitHub config
    const githubConfig = {
      owner: envConfig.github.username || existingConfig?.[0]?.githubConfig?.owner || '',
      type: envConfig.github.type || existingConfig?.[0]?.githubConfig?.type || 'personal',
      token: envConfig.github.token ? encrypt(envConfig.github.token) : existingConfig?.[0]?.githubConfig?.token || '',
      includeStarred: envConfig.github.mirrorStarred ?? existingConfig?.[0]?.githubConfig?.includeStarred ?? false,
      includeForks: !(envConfig.github.skipForks ?? false),
      skipForks: envConfig.github.skipForks ?? existingConfig?.[0]?.githubConfig?.skipForks ?? false,
      includeArchived: envConfig.github.includeArchived ?? existingConfig?.[0]?.githubConfig?.includeArchived ?? false,
      includePrivate: envConfig.github.privateRepositories ?? existingConfig?.[0]?.githubConfig?.includePrivate ?? false,
      includePublic: envConfig.github.publicRepositories ?? existingConfig?.[0]?.githubConfig?.includePublic ?? true,
      includeOrganizations: envConfig.github.mirrorOrganizations ? [] : (existingConfig?.[0]?.githubConfig?.includeOrganizations ?? []),
      starredReposOrg: envConfig.github.starredReposOrg || existingConfig?.[0]?.githubConfig?.starredReposOrg || 'starred',
      starredReposMode: envConfig.github.starredReposMode || existingConfig?.[0]?.githubConfig?.starredReposMode || 'dedicated-org',
      mirrorStrategy,
      defaultOrg: envConfig.gitea.organization || existingConfig?.[0]?.githubConfig?.defaultOrg || 'github-mirrors',
      starredCodeOnly: envConfig.github.starredCodeOnly ?? existingConfig?.[0]?.githubConfig?.starredCodeOnly ?? false,
      autoMirrorStarred: envConfig.github.autoMirrorStarred ?? existingConfig?.[0]?.githubConfig?.autoMirrorStarred ?? false,
      starredLists: envConfig.github.starredLists ?? existingConfig?.[0]?.githubConfig?.starredLists ?? [],
    };

    // Build Gitea config
    const giteaConfig = {
      url: envConfig.gitea.url || existingConfig?.[0]?.giteaConfig?.url || '',
      externalUrl: envConfig.gitea.externalUrl || existingConfig?.[0]?.giteaConfig?.externalUrl || undefined,
      token: envConfig.gitea.token ? encrypt(envConfig.gitea.token) : existingConfig?.[0]?.giteaConfig?.token || '',
      defaultOwner: envConfig.gitea.username || existingConfig?.[0]?.giteaConfig?.defaultOwner || '',
      organization: envConfig.gitea.organization || existingConfig?.[0]?.giteaConfig?.organization || undefined,
      preserveOrgStructure: mirrorStrategy === 'preserve' || mirrorStrategy === 'mixed',
      mirrorInterval: envConfig.gitea.mirrorInterval || existingConfig?.[0]?.giteaConfig?.mirrorInterval || '8h',
      lfs: envConfig.gitea.lfs ?? existingConfig?.[0]?.giteaConfig?.lfs ?? false,
      wiki: envConfig.mirror.mirrorWiki ?? existingConfig?.[0]?.giteaConfig?.wiki ?? false,
      visibility: envConfig.gitea.visibility || existingConfig?.[0]?.giteaConfig?.visibility || 'public',
      createOrg: envConfig.gitea.createOrg ?? existingConfig?.[0]?.giteaConfig?.createOrg ?? true,
      templateOwner: envConfig.gitea.templateOwner || existingConfig?.[0]?.giteaConfig?.templateOwner || undefined,
      templateRepo: envConfig.gitea.templateRepo || existingConfig?.[0]?.giteaConfig?.templateRepo || undefined,
      addTopics: envConfig.gitea.addTopics ?? existingConfig?.[0]?.giteaConfig?.addTopics ?? true,
      topicPrefix: envConfig.gitea.topicPrefix || existingConfig?.[0]?.giteaConfig?.topicPrefix || undefined,
      preserveVisibility: envConfig.gitea.preserveVisibility ?? existingConfig?.[0]?.giteaConfig?.preserveVisibility ?? false,
      forkStrategy: envConfig.gitea.forkStrategy || existingConfig?.[0]?.giteaConfig?.forkStrategy || 'reference',
      // Mirror metadata options
      mirrorReleases: envConfig.mirror.mirrorReleases ?? existingConfig?.[0]?.giteaConfig?.mirrorReleases ?? false,
      releaseLimit: envConfig.mirror.releaseLimit ?? existingConfig?.[0]?.giteaConfig?.releaseLimit ?? 10,
      issueConcurrency: envConfig.mirror.issueConcurrency && envConfig.mirror.issueConcurrency > 0
        ? envConfig.mirror.issueConcurrency
        : existingConfig?.[0]?.giteaConfig?.issueConcurrency ?? 3,
      pullRequestConcurrency: envConfig.mirror.pullRequestConcurrency && envConfig.mirror.pullRequestConcurrency > 0
        ? envConfig.mirror.pullRequestConcurrency
        : existingConfig?.[0]?.giteaConfig?.pullRequestConcurrency ?? 5,
      mirrorMetadata: envConfig.mirror.mirrorMetadata ?? (envConfig.mirror.mirrorIssues || envConfig.mirror.mirrorPullRequests || envConfig.mirror.mirrorLabels || envConfig.mirror.mirrorMilestones) ?? existingConfig?.[0]?.giteaConfig?.mirrorMetadata ?? false,
      mirrorIssues: envConfig.mirror.mirrorIssues ?? existingConfig?.[0]?.giteaConfig?.mirrorIssues ?? false,
      mirrorPullRequests: envConfig.mirror.mirrorPullRequests ?? existingConfig?.[0]?.giteaConfig?.mirrorPullRequests ?? false,
      mirrorLabels: envConfig.mirror.mirrorLabels ?? existingConfig?.[0]?.giteaConfig?.mirrorLabels ?? false,
      mirrorMilestones: envConfig.mirror.mirrorMilestones ?? existingConfig?.[0]?.giteaConfig?.mirrorMilestones ?? false,
      // Backup options — preserve existing values so UI-configured settings survive restart
      backupStrategy: existingConfig?.[0]?.giteaConfig?.backupStrategy ?? 'on-force-push',
      backupBeforeSync: existingConfig?.[0]?.giteaConfig?.backupBeforeSync ?? true,
      backupRetentionCount: existingConfig?.[0]?.giteaConfig?.backupRetentionCount ?? 5,
      backupRetentionDays: existingConfig?.[0]?.giteaConfig?.backupRetentionDays ?? 30,
      backupDirectory: existingConfig?.[0]?.giteaConfig?.backupDirectory || undefined,
      blockSyncOnBackupFailure: existingConfig?.[0]?.giteaConfig?.blockSyncOnBackupFailure ?? true,
    };

    // Build schedule config with support for interval as string or number
    const scheduleInterval = envConfig.schedule.interval || (existingConfig?.[0]?.scheduleConfig?.interval ?? '3600');
    const scheduleConfig = {
      enabled: envConfig.schedule.enabled ?? existingConfig?.[0]?.scheduleConfig?.enabled ?? false,
      interval: scheduleInterval,
      concurrent: envConfig.schedule.concurrent ?? existingConfig?.[0]?.scheduleConfig?.concurrent ?? false,
      batchSize: envConfig.schedule.batchSize ?? existingConfig?.[0]?.scheduleConfig?.batchSize ?? 10,
      pauseBetweenBatches: envConfig.schedule.pauseBetweenBatches ?? existingConfig?.[0]?.scheduleConfig?.pauseBetweenBatches ?? 5000,
      retryAttempts: envConfig.schedule.retryAttempts ?? existingConfig?.[0]?.scheduleConfig?.retryAttempts ?? 3,
      retryDelay: envConfig.schedule.retryDelay ?? existingConfig?.[0]?.scheduleConfig?.retryDelay ?? 60000,
      timeout: envConfig.schedule.timeout ?? existingConfig?.[0]?.scheduleConfig?.timeout ?? 3600000,
      autoRetry: envConfig.schedule.autoRetry ?? existingConfig?.[0]?.scheduleConfig?.autoRetry ?? true,
      cleanupBeforeMirror: envConfig.schedule.cleanupBeforeMirror ?? existingConfig?.[0]?.scheduleConfig?.cleanupBeforeMirror ?? false,
      notifyOnFailure: envConfig.schedule.notifyOnFailure ?? existingConfig?.[0]?.scheduleConfig?.notifyOnFailure ?? true,
      notifyOnSuccess: envConfig.schedule.notifyOnSuccess ?? existingConfig?.[0]?.scheduleConfig?.notifyOnSuccess ?? false,
      logLevel: envConfig.schedule.logLevel || existingConfig?.[0]?.scheduleConfig?.logLevel || 'info',
      timezone: envConfig.schedule.timezone || existingConfig?.[0]?.scheduleConfig?.timezone || 'UTC',
      onlyMirrorUpdated: envConfig.schedule.onlyMirrorUpdated ?? existingConfig?.[0]?.scheduleConfig?.onlyMirrorUpdated ?? false,
      updateInterval: envConfig.schedule.updateInterval ?? existingConfig?.[0]?.scheduleConfig?.updateInterval ?? 86400000,
      skipRecentlyMirrored: envConfig.schedule.skipRecentlyMirrored ?? existingConfig?.[0]?.scheduleConfig?.skipRecentlyMirrored ?? true,
      recentThreshold: envConfig.schedule.recentThreshold ?? existingConfig?.[0]?.scheduleConfig?.recentThreshold ?? 3600000,
      autoImport: envConfig.schedule.autoImport ?? existingConfig?.[0]?.scheduleConfig?.autoImport ?? true,
      autoMirror: envConfig.schedule.autoMirror ?? existingConfig?.[0]?.scheduleConfig?.autoMirror ?? false,
      lastRun: existingConfig?.[0]?.scheduleConfig?.lastRun || undefined,
      nextRun: existingConfig?.[0]?.scheduleConfig?.nextRun || undefined,
    };

    // Build cleanup config
    const cleanupConfig = {
      enabled: envConfig.cleanup.enabled ?? existingConfig?.[0]?.cleanupConfig?.enabled ?? false,
      retentionDays: envConfig.cleanup.retentionDays ? envConfig.cleanup.retentionDays * 86400 : existingConfig?.[0]?.cleanupConfig?.retentionDays ?? 604800, // Convert days to seconds
      deleteFromGitea: envConfig.cleanup.deleteFromGitea ?? existingConfig?.[0]?.cleanupConfig?.deleteFromGitea ?? false,
      deleteIfNotInGitHub: envConfig.cleanup.deleteIfNotInGitHub ?? existingConfig?.[0]?.cleanupConfig?.deleteIfNotInGitHub ?? true,
      protectedRepos: envConfig.cleanup.protectedRepos ?? existingConfig?.[0]?.cleanupConfig?.protectedRepos ?? [],
      dryRun: envConfig.cleanup.dryRun ?? existingConfig?.[0]?.cleanupConfig?.dryRun ?? true,
      orphanedRepoAction: envConfig.cleanup.orphanedRepoAction || existingConfig?.[0]?.cleanupConfig?.orphanedRepoAction || 'archive',
      batchSize: envConfig.cleanup.batchSize ?? existingConfig?.[0]?.cleanupConfig?.batchSize ?? 10,
      pauseBetweenDeletes: envConfig.cleanup.pauseBetweenDeletes ?? existingConfig?.[0]?.cleanupConfig?.pauseBetweenDeletes ?? 2000,
      lastRun: existingConfig?.[0]?.cleanupConfig?.lastRun || undefined,
      nextRun: existingConfig?.[0]?.cleanupConfig?.nextRun || undefined,
    };

    if (existingConfig.length > 0) {
      // Update existing config
      console.log('[ENV Config Loader] Updating existing configuration with environment variables');
      await db
        .update(configs)
        .set({
          githubConfig,
          giteaConfig,
          scheduleConfig,
          cleanupConfig,
          updatedAt: new Date(),
        })
        .where(eq(configs.id, existingConfig[0].id));
    } else {
      // Create new config
      console.log('[ENV Config Loader] Creating new configuration from environment variables');
      const configId = uuidv4();
      await db.insert(configs).values({
        id: configId,
        userId,
        name: 'Environment Configuration',
        isActive: true,
        githubConfig,
        giteaConfig,
        include: [],
        exclude: [],
        scheduleConfig,
        cleanupConfig,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    console.log('[ENV Config Loader] Configuration initialized successfully from environment variables');
  } catch (error) {
    console.error('[ENV Config Loader] Failed to initialize configuration from environment:', error);
    // Don't throw - this is a non-critical initialization
  }
}
