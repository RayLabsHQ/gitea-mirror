/**
 * Environment variable configuration loader
 * Loads configuration from environment variables and populates the database
 */

import { db, configs, users, repositories } from '@/lib/db';
import { eq, and, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { encrypt } from '@/lib/utils/encryption';
import { isSourceProviderKind, type SourceProviderKind } from '@/lib/source-providers/kinds';
import { DESTINATION_PROVIDER_DEFAULT_URLS, isDestinationProviderKind, type DestinationProviderKind } from '@/lib/destination-kinds';
import { hasDestinationChanged, hasSourceChanged, loadConfigLocks } from '@/lib/config-locks';
import type { SourceUpdateInput } from '@/lib/sources';
import { backupDefaultsFromEnv, storedBackupStrategy } from '@/lib/utils/backup-defaults';
import { normalizePrereleaseLimit, normalizeReleaseAssetLimit, normalizeReleaseTagPatterns, normalizeReleaseType, splitReleaseTagEntries } from '@/lib/utils/mirror-overrides';
import { STARRED_REPOS_MODES } from '@/lib/utils/starred-destination';

interface EnvConfig {
  github: {
    provider?: SourceProviderKind;
    url?: string;
    username?: string;
    token?: string;
    type?: 'personal' | 'organization';
    privateRepositories?: boolean;
    publicRepositories?: boolean;
    includeCollaboratorRepos?: boolean;
    mirrorStarred?: boolean;
    skipForks?: boolean;
    includeArchived?: boolean;
    mirrorOrganizations?: boolean;
    includeOrganizations?: string[];
    preserveOrgStructure?: boolean;
    onlyMirrorOrgs?: boolean;
    starredCodeOnly?: boolean;
    autoMirrorStarred?: boolean;
    starredReposOrg?: string;
    starredReposMode?: 'dedicated-org' | 'preserve-owner' | 'follow-strategy';
    starredDuplicateStrategy?: 'suffix' | 'prefix' | 'owner-org';
    starredLists?: string[];
    mirrorStrategy?: 'preserve' | 'single-org' | 'flat-user' | 'mixed';
  };
  gitea: {
    provider?: DestinationProviderKind;
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
    releaseAssetLimit?: number;
    prereleaseLimit?: number;
    pruneOldReleaseAssets?: boolean;
    releaseType?: string;
    releaseIncludeTags?: string[];
    releaseExcludeTags?: string[];
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
 * A true/false variable. Unset or empty is undefined, so the value stored from
 * the Configuration page is kept; "true" (any case) is true and anything else
 * is false. Unset used to read as false and was saved over the stored value on
 * every start, so setting a token through the environment turned topics, issue
 * mirroring, scheduling and more back off at each restart.
 */
function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return raw.toLowerCase() === 'true';
}

/** True when any of the variables is "true", undefined when none is set. */
function envFlagAny(...names: string[]): boolean | undefined {
  const values = names.map(envFlag);
  if (values.includes(true)) return true;
  return values.includes(false) ? false : undefined;
}

/**
 * ENVIRONMENT_SEEDING decides whether the environment is copied into the
 * database at all (#541). "true" copies it even when no connection variable
 * is set, so tokens can stay on the Configuration page while settings such as
 * AUTO_IMPORT_REPOS come from the environment. "false" never copies it.
 * Unset keeps the old rule (see hasEnvConfig). Any other value is treated as
 * unset with a warning, so a typo such as "1" cannot switch seeding off.
 */
function environmentSeeding(): boolean | undefined {
  const raw = process.env.ENVIRONMENT_SEEDING?.trim();
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  console.warn(
    `[ENV Config Loader] Ignoring ENVIRONMENT_SEEDING="${raw}": use true or false`
  );
  return undefined;
}

/**
 * Parse environment variables into configuration object
 */
function parseEnvConfig(): EnvConfig {
  // Parse protected repos from comma-separated string
  const protectedRepos = process.env.CLEANUP_PROTECTED_REPOS 
    ? process.env.CLEANUP_PROTECTED_REPOS.split(',').map(r => r.trim()).filter(Boolean)
    : undefined;
  const includeOrganizations = process.env.INCLUDE_ORGANIZATIONS
    ? process.env.INCLUDE_ORGANIZATIONS.split(',').map((org) => org.trim()).filter(Boolean)
    : undefined;
  const starredLists = process.env.MIRROR_STARRED_LISTS
    ? process.env.MIRROR_STARRED_LISTS.split(',').map((list) => list.trim()).filter(Boolean)
    : undefined;
  // Release tag patterns are comma separated, but a comma inside the slash
  // form belongs to the regular expression (^v\d{1,3}\.\d+$), so the split
  // skips commas inside /.../ - the same rules the dialog applies.
  const releaseIncludeTags = process.env.RELEASE_INCLUDE_TAGS
    ? splitReleaseTagEntries(process.env.RELEASE_INCLUDE_TAGS)
    : undefined;
  const releaseExcludeTags = process.env.RELEASE_EXCLUDE_TAGS
    ? splitReleaseTagEntries(process.env.RELEASE_EXCLUDE_TAGS)
    : undefined;

  return {
    github: {
      // SOURCE_PROVIDER picks GitHub, GitLab or Gitea/Forgejo; SOURCE_URL is
      // the instance base URL for the last two. Username and token still come
      // from GITHUB_USERNAME and GITHUB_TOKEN whatever the provider.
      provider: isSourceProviderKind(process.env.SOURCE_PROVIDER)
        ? process.env.SOURCE_PROVIDER
        : undefined,
      url: process.env.SOURCE_URL,
      username: process.env.GITHUB_USERNAME,
      token: process.env.GITHUB_TOKEN,
      type: process.env.GITHUB_TYPE as 'personal' | 'organization',
      privateRepositories: envFlag('PRIVATE_REPOSITORIES'),
      publicRepositories: envFlag('PUBLIC_REPOSITORIES'),
      includeCollaboratorRepos: envFlag('INCLUDE_COLLABORATOR_REPOS'),
      mirrorStarred: envFlag('MIRROR_STARRED'),
      skipForks: envFlag('SKIP_FORKS'),
      includeArchived: envFlag('INCLUDE_ARCHIVED'),
      mirrorOrganizations: envFlag('MIRROR_ORGANIZATIONS'),
      includeOrganizations,
      preserveOrgStructure: envFlag('PRESERVE_ORG_STRUCTURE'),
      onlyMirrorOrgs: envFlag('ONLY_MIRROR_ORGS'),
      starredCodeOnly: envFlag('SKIP_STARRED_ISSUES'),
      autoMirrorStarred: envFlag('AUTO_MIRROR_STARRED'),
      starredReposOrg: process.env.STARRED_REPOS_ORG,
      // An unknown value is ignored rather than stored, so it cannot break the saved settings.
      starredReposMode: (STARRED_REPOS_MODES as readonly string[]).includes(process.env.STARRED_REPOS_MODE ?? '')
        ? (process.env.STARRED_REPOS_MODE as 'dedicated-org' | 'preserve-owner' | 'follow-strategy')
        : undefined,
      starredDuplicateStrategy: process.env.STARRED_DUPLICATE_STRATEGY as 'suffix' | 'prefix' | 'owner-org',
      starredLists,
      mirrorStrategy: process.env.MIRROR_STRATEGY as 'preserve' | 'single-org' | 'flat-user' | 'mixed',
    },
    gitea: {
      // DESTINATION_PROVIDER picks Gitea or Forgejo (pull mirrors, same API),
      // or GitHub or GitLab (push targets served by the push engine).
      provider: isDestinationProviderKind(process.env.DESTINATION_PROVIDER)
        ? process.env.DESTINATION_PROVIDER
        : undefined,
      url: process.env.GITEA_URL,
      externalUrl: process.env.GITEA_EXTERNAL_URL,
      username: process.env.GITEA_USERNAME,
      token: process.env.GITEA_TOKEN,
      organization: process.env.GITEA_ORGANIZATION,
      visibility: process.env.GITEA_ORG_VISIBILITY as 'public' | 'private' | 'limited' | 'default',
      mirrorInterval: process.env.GITEA_MIRROR_INTERVAL,
      lfs: envFlag('GITEA_LFS'),
      createOrg: envFlag('GITEA_CREATE_ORG'),
      templateOwner: process.env.GITEA_TEMPLATE_OWNER,
      templateRepo: process.env.GITEA_TEMPLATE_REPO,
      addTopics: envFlag('GITEA_ADD_TOPICS'),
      topicPrefix: process.env.GITEA_TOPIC_PREFIX,
      preserveVisibility: envFlag('GITEA_PRESERVE_VISIBILITY'),
      forkStrategy: process.env.GITEA_FORK_STRATEGY as 'skip' | 'reference' | 'full-copy',
    },
    mirror: {
      mirrorIssues: envFlag('MIRROR_ISSUES'),
      mirrorWiki: envFlag('MIRROR_WIKI'),
      mirrorReleases: envFlag('MIRROR_RELEASES'),
      mirrorPullRequests: envFlag('MIRROR_PULL_REQUESTS'),
      mirrorLabels: envFlag('MIRROR_LABELS'),
      mirrorMilestones: envFlag('MIRROR_MILESTONES'),
      mirrorMetadata: envFlag('MIRROR_METADATA'),
      releaseLimit: process.env.RELEASE_LIMIT ? parseInt(process.env.RELEASE_LIMIT, 10) : undefined,
      releaseAssetLimit: process.env.RELEASE_ASSET_LIMIT ? parseInt(process.env.RELEASE_ASSET_LIMIT, 10) : undefined,
      prereleaseLimit: process.env.RELEASE_PRERELEASE_LIMIT ? parseInt(process.env.RELEASE_PRERELEASE_LIMIT, 10) : undefined,
      pruneOldReleaseAssets: envFlag('PRUNE_OLD_RELEASE_ASSETS'),
      releaseType: process.env.RELEASE_TYPE,
      releaseIncludeTags,
      releaseExcludeTags,
      issueConcurrency: process.env.MIRROR_ISSUE_CONCURRENCY ? parseInt(process.env.MIRROR_ISSUE_CONCURRENCY, 10) : undefined,
      pullRequestConcurrency: process.env.MIRROR_PULL_REQUEST_CONCURRENCY ? parseInt(process.env.MIRROR_PULL_REQUEST_CONCURRENCY, 10) : undefined,
    },
    schedule: {
      // Any interval variable switches the schedule on, as it always has, even
      // next to SCHEDULE_ENABLED=false. With none of them set, the stored
      // value stays.
      enabled:
        process.env.GITEA_MIRROR_INTERVAL || process.env.SCHEDULE_INTERVAL || process.env.DELAY
          ? true
          : envFlag('SCHEDULE_ENABLED'),
      interval: process.env.SCHEDULE_INTERVAL || process.env.GITEA_MIRROR_INTERVAL || process.env.DELAY, // Support GITEA_MIRROR_INTERVAL, SCHEDULE_INTERVAL, and old DELAY
      concurrent: envFlag('SCHEDULE_CONCURRENT'),
      batchSize: process.env.SCHEDULE_BATCH_SIZE ? parseInt(process.env.SCHEDULE_BATCH_SIZE, 10) : undefined,
      pauseBetweenBatches: process.env.SCHEDULE_PAUSE_BETWEEN_BATCHES ? parseInt(process.env.SCHEDULE_PAUSE_BETWEEN_BATCHES, 10) : undefined,
      retryAttempts: process.env.SCHEDULE_RETRY_ATTEMPTS ? parseInt(process.env.SCHEDULE_RETRY_ATTEMPTS, 10) : undefined,
      retryDelay: process.env.SCHEDULE_RETRY_DELAY ? parseInt(process.env.SCHEDULE_RETRY_DELAY, 10) : undefined,
      timeout: process.env.SCHEDULE_TIMEOUT ? parseInt(process.env.SCHEDULE_TIMEOUT, 10) : undefined,
      autoRetry: envFlag('SCHEDULE_AUTO_RETRY'),
      cleanupBeforeMirror: envFlag('SCHEDULE_CLEANUP_BEFORE_MIRROR'),
      notifyOnFailure: envFlag('SCHEDULE_NOTIFY_ON_FAILURE'),
      notifyOnSuccess: envFlag('SCHEDULE_NOTIFY_ON_SUCCESS'),
      logLevel: process.env.SCHEDULE_LOG_LEVEL as 'error' | 'warn' | 'info' | 'debug',
      timezone: process.env.SCHEDULE_TIMEZONE,
      onlyMirrorUpdated: envFlag('SCHEDULE_ONLY_MIRROR_UPDATED'),
      updateInterval: process.env.SCHEDULE_UPDATE_INTERVAL ? parseInt(process.env.SCHEDULE_UPDATE_INTERVAL, 10) : undefined,
      skipRecentlyMirrored: envFlag('SCHEDULE_SKIP_RECENTLY_MIRRORED'),
      recentThreshold: process.env.SCHEDULE_RECENT_THRESHOLD ? parseInt(process.env.SCHEDULE_RECENT_THRESHOLD, 10) : undefined,
      // On by default: only an explicit "false" turns it off, and unset keeps
      // what is stored.
      autoImport: process.env.AUTO_IMPORT_REPOS?.trim() ? process.env.AUTO_IMPORT_REPOS.trim().toLowerCase() !== 'false' : undefined,
      autoMirror: envFlag('AUTO_MIRROR_REPOS'),
    },
    cleanup: {
      // CLEANUP_DELETE_IF_NOT_IN_GITHUB=true switches cleanup on too.
      enabled: envFlagAny('CLEANUP_ENABLED', 'CLEANUP_DELETE_IF_NOT_IN_GITHUB'),
      retentionDays: process.env.CLEANUP_RETENTION_DAYS ? parseInt(process.env.CLEANUP_RETENTION_DAYS, 10) : undefined,
      deleteFromGitea: envFlag('CLEANUP_DELETE_FROM_GITEA'),
      deleteIfNotInGitHub: envFlag('CLEANUP_DELETE_IF_NOT_IN_GITHUB'),
      protectedRepos,
      dryRun: envFlag('CLEANUP_DRY_RUN'),
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
    const seeding = environmentSeeding();

    if (seeding === false) {
      console.log('[ENV Config Loader] ENVIRONMENT_SEEDING=false, skipping initialization');
      return;
    }

    // Without ENVIRONMENT_SEEDING=true, a connection variable has to be set.
    if (seeding !== true && !hasEnvConfig(envConfig)) {
      console.log('[ENV Config Loader] No environment configuration found, skipping initialization');
      return;
    }

    console.log('[ENV Config Loader] Found environment configuration, initializing...');

    // Get the first user (admin user) — deterministic order so we always pick the
    // same row across restarts even if multiple users exist.
    const firstUser = await db
      .select()
      .from(users)
      .orderBy(sql`${users.createdAt} ASC`)
      .limit(1);

    if (firstUser.length === 0) {
      console.log('[ENV Config Loader] No users found, skipping configuration initialization');
      return;
    }

    const userId = firstUser[0].id;

    // Check if config already exists for this user — prefer the active config and
    // fall back to most-recently-updated so we never write env values into a stale
    // inactive stub while the populated active row sits untouched (see issue #271).
    const existingConfig = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    // A source with imported repositories, or a destination with mirrors, is
    // locked: an environment variable that disagrees is ignored with a
    // warning rather than switching hosts underneath existing mirrors. The
    // Configuration page can still change them, with confirmation.
    if (existingConfig[0]) {
      const stored = existingConfig[0];
      const locks = await loadConfigLocks(userId);
      const incomingSource = {
        provider: envConfig.github.provider ?? stored.githubConfig?.provider,
        url: envConfig.github.url ?? stored.githubConfig?.url,
      };
      if (locks.source.locked && hasSourceChanged(stored.githubConfig, incomingSource)) {
        console.warn(
          `[ENV Config Loader] Ignoring SOURCE_PROVIDER/SOURCE_URL: the source is locked because ${locks.source.repositoryCount} repositories were imported from it. Change it on the Configuration page.`
        );
        envConfig.github.provider = undefined;
        envConfig.github.url = undefined;
      }
      if (locks.destination.locked && hasDestinationChanged(stored.giteaConfig?.url, envConfig.gitea.url)) {
        console.warn(
          `[ENV Config Loader] Ignoring GITEA_URL: the destination is locked because ${locks.destination.mirroredCount} repositories are mirrored to it. Change it on the Configuration page.`
        );
        envConfig.gitea.url = undefined;
      }
    }

    // MIRROR_STRATEGY wins, then PRESERVE_ORG_STRUCTURE when it is set. With
    // neither, the stored strategy stays, so a choice made on the
    // Configuration page survives a restart. A first start with nothing
    // stored keeps the old rule: an organization means single-org.
    type MirrorStrategy = 'preserve' | 'single-org' | 'flat-user' | 'mixed';
    const storedStrategy = existingConfig?.[0]?.githubConfig?.mirrorStrategy as MirrorStrategy | undefined;
    let mirrorStrategy: MirrorStrategy;
    if (envConfig.github.mirrorStrategy) {
      mirrorStrategy = envConfig.github.mirrorStrategy;
    } else if (envConfig.github.preserveOrgStructure === true) {
      mirrorStrategy = 'preserve';
    } else if (envConfig.github.preserveOrgStructure === false && envConfig.gitea.organization) {
      mirrorStrategy = 'single-org';
    } else if (storedStrategy) {
      mirrorStrategy = storedStrategy;
    } else {
      mirrorStrategy = envConfig.gitea.organization ? 'single-org' : 'preserve';
    }

    // Build GitHub config
    const githubConfig = {
      owner: envConfig.github.username || existingConfig?.[0]?.githubConfig?.owner || '',
      type: envConfig.github.type || existingConfig?.[0]?.githubConfig?.type || 'personal',
      provider: envConfig.github.provider || existingConfig?.[0]?.githubConfig?.provider || 'github',
      url: envConfig.github.url || existingConfig?.[0]?.githubConfig?.url || undefined,
      token: envConfig.github.token ? encrypt(envConfig.github.token) : existingConfig?.[0]?.githubConfig?.token || '',
      includeStarred: envConfig.github.mirrorStarred ?? existingConfig?.[0]?.githubConfig?.includeStarred ?? false,
      includeForks: !(envConfig.github.skipForks ?? existingConfig?.[0]?.githubConfig?.skipForks ?? false),
      skipForks: envConfig.github.skipForks ?? existingConfig?.[0]?.githubConfig?.skipForks ?? false,
      includeArchived: envConfig.github.includeArchived ?? existingConfig?.[0]?.githubConfig?.includeArchived ?? false,
      includePrivate: envConfig.github.privateRepositories ?? existingConfig?.[0]?.githubConfig?.includePrivate ?? false,
      includePublic: envConfig.github.publicRepositories ?? existingConfig?.[0]?.githubConfig?.includePublic ?? true,
      includeCollaboratorRepos: envConfig.github.includeCollaboratorRepos ?? existingConfig?.[0]?.githubConfig?.includeCollaboratorRepos ?? true,
      // Opt-in org allowlist from INCLUDE_ORGANIZATIONS (comma-separated). Falls
      // back to existing config so the UI-managed list isn't clobbered on restart.
      includeOrganizations: envConfig.github.includeOrganizations ?? existingConfig?.[0]?.githubConfig?.includeOrganizations ?? [],
      starredReposOrg: envConfig.github.starredReposOrg || existingConfig?.[0]?.githubConfig?.starredReposOrg || 'starred',
      starredReposMode: envConfig.github.starredReposMode || existingConfig?.[0]?.githubConfig?.starredReposMode || 'dedicated-org',
      starredDuplicateStrategy: envConfig.github.starredDuplicateStrategy || existingConfig?.[0]?.githubConfig?.starredDuplicateStrategy || 'suffix',
      mirrorStrategy,
      defaultOrg: envConfig.gitea.organization || existingConfig?.[0]?.githubConfig?.defaultOrg || 'github-mirrors',
      starredCodeOnly: envConfig.github.starredCodeOnly ?? existingConfig?.[0]?.githubConfig?.starredCodeOnly ?? false,
      autoMirrorStarred: envConfig.github.autoMirrorStarred ?? existingConfig?.[0]?.githubConfig?.autoMirrorStarred ?? false,
      starredLists: envConfig.github.starredLists ?? existingConfig?.[0]?.githubConfig?.starredLists ?? [],
      // ONLY_MIRROR_ORGS=true maps to skipPersonalRepos: true
      skipPersonalRepos: envConfig.github.onlyMirrorOrgs ?? existingConfig?.[0]?.githubConfig?.skipPersonalRepos ?? false,
    };

    // Build Gitea config
    const storedGitea = existingConfig?.[0]?.giteaConfig;
    const backupDefaults = backupDefaultsFromEnv();
    const backupStrategy = storedBackupStrategy(storedGitea) ?? backupDefaults.backupStrategy;
    const giteaConfig = {
      url:
        envConfig.gitea.url ||
        existingConfig?.[0]?.giteaConfig?.url ||
        // GitHub and GitLab targets default to their public instance.
        DESTINATION_PROVIDER_DEFAULT_URLS[envConfig.gitea.provider || existingConfig?.[0]?.giteaConfig?.provider || 'gitea'] ||
        '',
      provider: envConfig.gitea.provider || existingConfig?.[0]?.giteaConfig?.provider || 'gitea',
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
      // 0 is a real value (notes only); unset means assets for every mirrored release.
      releaseAssetLimit:
        normalizeReleaseAssetLimit(envConfig.mirror.releaseAssetLimit) ??
        existingConfig?.[0]?.giteaConfig?.releaseAssetLimit ??
        null,
      // 0 is a real value (no pre-releases); unset means no separate limit.
      prereleaseLimit:
        normalizePrereleaseLimit(envConfig.mirror.prereleaseLimit) ??
        existingConfig?.[0]?.giteaConfig?.prereleaseLimit ??
        null,
      // Unset env var keeps what the UI stored, like every switch here.
      pruneOldReleaseAssets:
        envConfig.mirror.pruneOldReleaseAssets ??
        existingConfig?.[0]?.giteaConfig?.pruneOldReleaseAssets ??
        false,
      // all | stable. An unusable value (a typo in the env var)
      // falls through to the stored value rather than storing a filter.
      releaseType:
        normalizeReleaseType(envConfig.mirror.releaseType) ??
        existingConfig?.[0]?.giteaConfig?.releaseType ??
        'all',
      // Comma separated glob patterns (or the /regex/ form). An unset or unusable
      // variable keeps what the UI stored, matching how RELEASE_TYPE behaves.
      releaseIncludeTags:
        normalizeReleaseTagPatterns(envConfig.mirror.releaseIncludeTags) ??
        existingConfig?.[0]?.giteaConfig?.releaseIncludeTags ??
        [],
      releaseExcludeTags:
        normalizeReleaseTagPatterns(envConfig.mirror.releaseExcludeTags) ??
        existingConfig?.[0]?.giteaConfig?.releaseExcludeTags ??
        [],
      issueConcurrency: envConfig.mirror.issueConcurrency && envConfig.mirror.issueConcurrency > 0
        ? envConfig.mirror.issueConcurrency
        : existingConfig?.[0]?.giteaConfig?.issueConcurrency ?? 3,
      pullRequestConcurrency: envConfig.mirror.pullRequestConcurrency && envConfig.mirror.pullRequestConcurrency > 0
        ? envConfig.mirror.pullRequestConcurrency
        : existingConfig?.[0]?.giteaConfig?.pullRequestConcurrency ?? 5,
      // Turning on any metadata kind turns on the metadata switch too.
      mirrorMetadata:
        envConfig.mirror.mirrorMetadata ??
        ([envConfig.mirror.mirrorIssues, envConfig.mirror.mirrorPullRequests, envConfig.mirror.mirrorLabels, envConfig.mirror.mirrorMilestones].includes(true)
          ? true
          : undefined) ??
        existingConfig?.[0]?.giteaConfig?.mirrorMetadata ??
        false,
      mirrorIssues: envConfig.mirror.mirrorIssues ?? existingConfig?.[0]?.giteaConfig?.mirrorIssues ?? false,
      // No env vars for these; keep what the UI stored across restarts.
      mirrorIssueState: existingConfig?.[0]?.giteaConfig?.mirrorIssueState ?? 'all',
      mirrorIssueComments: existingConfig?.[0]?.giteaConfig?.mirrorIssueComments ?? true,
      mirrorIssueMedia: existingConfig?.[0]?.giteaConfig?.mirrorIssueMedia ?? true,
      mirrorPullRequests: envConfig.mirror.mirrorPullRequests ?? existingConfig?.[0]?.giteaConfig?.mirrorPullRequests ?? false,
      mirrorLabels: envConfig.mirror.mirrorLabels ?? existingConfig?.[0]?.giteaConfig?.mirrorLabels ?? false,
      mirrorMilestones: envConfig.mirror.mirrorMilestones ?? existingConfig?.[0]?.giteaConfig?.mirrorMilestones ?? false,
      // Backup options: keep what is stored so UI-configured settings survive a
      // restart, and start from PRE_SYNC_BACKUP_* when nothing is (#503).
      backupStrategy,
      backupBeforeSync: storedGitea?.backupBeforeSync ?? backupStrategy !== 'disabled',
      backupRetentionCount: storedGitea?.backupRetentionCount ?? backupDefaults.backupRetentionCount,
      backupRetentionDays: storedGitea?.backupRetentionDays ?? backupDefaults.backupRetentionDays,
      backupDirectory: storedGitea?.backupDirectory || backupDefaults.backupDirectory,
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

    await syncFirstSourceFromEnv(userId, envConfig);

    console.log('[ENV Config Loader] Configuration initialized successfully from environment variables');
  } catch (error) {
    console.error('[ENV Config Loader] Failed to initialize configuration from environment:', error);
    // Don't throw - this is a non-critical initialization
  }
}

/**
 * Keep the user's first (primary) source row in sync with the environment
 * connection variables. The sources table is authoritative for connections;
 * createSource/updateSource mirror the primary source back into the config's
 * githubConfig connection fields (write-through). Never clears values the
 * env did not set.
 */
async function syncFirstSourceFromEnv(userId: string, envConfig: EnvConfig): Promise<void> {
  try {
    const { createSource, listSources, updateSource } = await import('@/lib/sources');
    const existingSources = await listSources(userId);

    if (existingSources.length === 0) {
      // Only mint a source row when the environment actually carries a
      // connection; preference-only envs must not create an empty source.
      if (envConfig.github.token || envConfig.github.username) {
        await createSource(userId, {
          provider: envConfig.github.provider ?? 'github',
          url: envConfig.github.url,
          username: envConfig.github.username ?? '',
          token: envConfig.github.token ?? '',
        });
        console.log('[ENV Config Loader] Created the primary source from environment variables');
      }
      return;
    }

    const primary = existingSources[0];

    const updates: SourceUpdateInput = {};
    if (envConfig.github.provider !== undefined) {
      updates.provider = envConfig.github.provider;
    }
    if (envConfig.github.url !== undefined) {
      updates.url = envConfig.github.url;
    }
    if (envConfig.github.username !== undefined) {
      updates.username = envConfig.github.username;
    }
    if (envConfig.github.token) {
      updates.token = envConfig.github.token;
    }

    // A source with imported repositories is locked: environment variables
    // cannot switch its host, mirroring the githubConfig check above.
    const sourceRepoCount = await countRepositoriesForSource(userId, primary.id);
    const incomingSource = {
      provider: envConfig.github.provider ?? primary.provider,
      url: envConfig.github.url ?? primary.url,
    };
    const lockedHostChange =
      sourceRepoCount > 0 &&
      (updates.provider !== undefined || updates.url !== undefined) &&
      hasSourceChanged({ provider: primary.provider, url: primary.url }, incomingSource);
    if (lockedHostChange) {
      console.warn(
        `[ENV Config Loader] Ignoring SOURCE_PROVIDER/SOURCE_URL: the source "${primary.name}" is locked because ${sourceRepoCount} repositories were imported from it. Change it on the Configuration page.`
      );
      delete updates.provider;
      delete updates.url;
    }

    await updateSource(userId, primary.id, updates);
  } catch (error) {
    console.error('[ENV Config Loader] Failed to sync the primary source from environment variables:', error);
  }
}

async function countRepositoriesForSource(userId: string, sourceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(and(eq(repositories.userId, userId), eq(repositories.sourceId, sourceId)));
  return Number(row?.count ?? 0);
}
