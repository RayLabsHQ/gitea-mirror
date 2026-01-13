import {
  repoStatusEnum,
  type RepositoryVisibility,
  type RepoStatus,
} from "@/types/Repository";
import { membershipRoleEnum } from "@/types/organizations";
import { Octokit } from "@octokit/rest";
import type { Config } from "@/types/config";
import type { Organization, Repository } from "./db/schema";
import { httpPost, httpGet, httpDelete, httpPut, httpPatch } from "./http-client";
import { createMirrorJob } from "./helpers";
import { db, organizations, repositories } from "./db";
import { eq, and } from "drizzle-orm";
import { decryptConfigTokens } from "./utils/config-encryption";
import { formatDateShort } from "./utils";
import {
  parseRepositoryMetadataState,
  serializeRepositoryMetadataState,
} from "./metadata-state";

/**
 * Helper function to get organization configuration including destination override
 */
export const getOrganizationConfig = async ({
  orgName,
  userId,
}: {
  orgName: string;
  userId: string;
}): Promise<Organization | null> => {
  try {
    const result = await db
      .select()
      .from(organizations)
      .where(and(eq(organizations.name, orgName), eq(organizations.userId, userId)))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    // Validate and cast the membershipRole to ensure type safety
    const rawOrg = result[0];
    const membershipRole = membershipRoleEnum.parse(rawOrg.membershipRole);
    const status = repoStatusEnum.parse(rawOrg.status);

    return {
      ...rawOrg,
      membershipRole,
      status,
    } as Organization;
  } catch (error) {
    console.error(`Error fetching organization config for ${orgName}:`, error);
    return null;
  }
};

/**
 * Enhanced async version of getGiteaRepoOwner that supports organization overrides
 */
export const getGiteaRepoOwnerAsync = async ({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: Repository;
}): Promise<string> => {
  if (!config.githubConfig || !config.giteaConfig) {
    throw new Error("GitHub or Gitea config is required.");
  }

  if (!config.giteaConfig.defaultOwner) {
    throw new Error("Gitea username is required.");
  }

  if (!config.userId) {
    throw new Error("User ID is required for organization overrides.");
  }

  // Check if repository is starred - starred repos always go to starredReposOrg (highest priority)
  if (repository.isStarred) {
    return config.githubConfig.starredReposOrg || "starred";
  }

  // Check for repository-specific override (second highest priority)
  if (repository.destinationOrg) {
    console.log(`Using repository override: ${repository.fullName} -> ${repository.destinationOrg}`);
    return repository.destinationOrg;
  }

  // Check for organization-specific override
  if (repository.organization) {
    const orgConfig = await getOrganizationConfig({
      orgName: repository.organization,
      userId: config.userId,
    });

    if (orgConfig?.destinationOrg) {
      console.log(`Using organization override: ${repository.organization} -> ${orgConfig.destinationOrg}`);
      return orgConfig.destinationOrg;
    }
  }

  // For personal repos (not organization repos), fall back to the default strategy

  // Fall back to existing strategy logic
  return getGiteaRepoOwner({ config, repository });
};

export const getGiteaRepoOwner = ({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: Repository;
}): string => {
  if (!config.githubConfig || !config.giteaConfig) {
    throw new Error("GitHub or Gitea config is required.");
  }

  if (!config.giteaConfig.defaultOwner) {
    throw new Error("Gitea username is required.");
  }

  // Check if repository is starred - starred repos always go to starredReposOrg
  if (repository.isStarred) {
    return config.githubConfig.starredReposOrg || "starred";
  }

  // Get the mirror strategy - use preserveOrgStructure for backward compatibility
  const mirrorStrategy = config.githubConfig.mirrorStrategy || 
    (config.giteaConfig.preserveOrgStructure ? "preserve" : "flat-user");

  switch (mirrorStrategy) {
    case "preserve":
      // Keep GitHub structure - org repos go to same org, personal repos to user (or override)
      if (repository.organization) {
        return repository.organization;
      }
      // Use personal repos override if configured, otherwise use username
      return config.giteaConfig.defaultOwner;

    case "single-org":
      // All non-starred repos go to the destination organization
      if (config.giteaConfig.organization) {
        return config.giteaConfig.organization;
      }
      // Fallback to username if no organization specified
      return config.giteaConfig.defaultOwner;

    case "flat-user":
      // All non-starred repos go under the user account
      return config.giteaConfig.defaultOwner;

    case "mixed":
      // Mixed mode: personal repos to single org, organization repos preserve structure
      if (repository.organization) {
        // Organization repos preserve their structure
        return repository.organization;
      }
      // Personal repos go to configured organization (same as single-org)
      if (config.giteaConfig.organization) {
        return config.giteaConfig.organization;
      }
      // Fallback to username if no organization specified
      return config.giteaConfig.defaultOwner;

    default:
      // Default fallback
      return config.giteaConfig.defaultOwner;
  }
};

export const isRepoPresentInGitea = async ({
  config,
  owner,
  repoName,
}: {
  config: Partial<Config>;
  owner: string;
  repoName: string;
}): Promise<boolean> => {
  try {
    if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
      throw new Error("Gitea config is required.");
    }

    // Decrypt config tokens for API usage
    const decryptedConfig = decryptConfigTokens(config as Config);

    // Check if the repository exists at the specified owner location
    const response = await fetch(
      `${config.giteaConfig.url}/api/v1/repos/${owner}/${repoName}`,
      {
        headers: {
          Authorization: `token ${decryptedConfig.giteaConfig.token}`,
        },
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Error checking if repo exists in Gitea:", error);
    return false;
  }
};

/**
 * Check if a repository is currently being mirrored (in-progress state in database)
 * This prevents race conditions where multiple concurrent operations try to mirror the same repo
 */
export const isRepoCurrentlyMirroring = async ({
  config,
  repoName,
  expectedLocation,
}: {
  config: Partial<Config>;
  repoName: string;
  expectedLocation?: string; // Format: "owner/repo"
}): Promise<boolean> => {
  try {
    if (!config.userId) {
      return false;
    }

    const { or } = await import("drizzle-orm");

    // Check database for any repository with "mirroring" or "syncing" status
    const inProgressRepos = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, config.userId),
          eq(repositories.name, repoName),
          // Check for in-progress statuses
          or(
            eq(repositories.status, "mirroring"),
            eq(repositories.status, "syncing")
          )
        )
      );

    if (inProgressRepos.length > 0) {
      // Check if any of the in-progress repos are stale (stuck for > 2 hours)
      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      const now = new Date().getTime();

      const activeRepos = inProgressRepos.filter((repo) => {
        if (!repo.updatedAt) return true; // No timestamp, assume active
        const updatedTime = new Date(repo.updatedAt).getTime();
        const isStale = (now - updatedTime) > TWO_HOURS_MS;

        if (isStale) {
          console.warn(
            `[Idempotency] Repository ${repo.name} has been in "${repo.status}" status for over 2 hours. ` +
            `Considering it stale and allowing retry.`
          );
        }

        return !isStale;
      });

      if (activeRepos.length === 0) {
        console.log(
          `[Idempotency] All in-progress operations for ${repoName} are stale (>2h). Allowing retry.`
        );
        return false;
      }

      // If we have an expected location, verify it matches
      if (expectedLocation) {
        const matchingRepo = activeRepos.find(
          (repo) => repo.mirroredLocation === expectedLocation
        );
        if (matchingRepo) {
          console.log(
            `[Idempotency] Repository ${repoName} is already being mirrored at ${expectedLocation}`
          );
          return true;
        }
      } else {
        console.log(
          `[Idempotency] Repository ${repoName} is already being mirrored (${activeRepos.length} in-progress operations found)`
        );
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("Error checking if repo is currently mirroring:", error);
    console.error("Error details:", error);
    return false;
  }
};

/**
 * Helper function to check if a repository exists in Gitea.
 * First checks the recorded mirroredLocation, then falls back to the expected location.
 */
export const checkRepoLocation = async ({
  config,
  repository,
  expectedOwner,
}: {
  config: Partial<Config>;
  repository: Repository;
  expectedOwner: string;
}): Promise<{ present: boolean; actualOwner: string }> => {
  // First check if we have a recorded mirroredLocation and if the repo exists there
  if (
    repository.mirroredLocation &&
    repository.mirroredLocation.trim() !== ""
  ) {
    const [mirroredOwner] = repository.mirroredLocation.split("/");
    if (mirroredOwner) {
      const mirroredPresent = await isRepoPresentInGitea({
        config,
        owner: mirroredOwner,
        repoName: repository.name,
      });

      if (mirroredPresent) {
        console.log(
          `Repository found at recorded mirrored location: ${repository.mirroredLocation}`
        );
        return { present: true, actualOwner: mirroredOwner };
      }
    }
  }

  // If not found at the recorded location, check the expected location
  const present = await isRepoPresentInGitea({
    config,
    owner: expectedOwner,
    repoName: repository.name,
  });

  if (present) {
    return { present: true, actualOwner: expectedOwner };
  }

  // Repository not found at any location
  return { present: false, actualOwner: expectedOwner };
};

export const mirrorGithubRepoToGitea = async ({
  octokit,
  repository,
  config,
}: {
  octokit: Octokit;
  repository: Repository;
  config: Partial<Config>;
}): Promise<any> => {
  try {
    if (!config.userId || !config.githubConfig || !config.giteaConfig) {
      throw new Error("github config and gitea config are required.");
    }

    if (!config.giteaConfig.defaultOwner) {
      throw new Error("Gitea username is required.");
    }

    // Decrypt config tokens for API usage
    const decryptedConfig = decryptConfigTokens(config as Config);

    // Get the correct owner based on the strategy (with organization overrides)
    let repoOwner = await getGiteaRepoOwnerAsync({ config, repository });

    // Determine the actual repository name to use (handle duplicates for starred repos)
    let targetRepoName = repository.name;

    if (repository.isStarred && config.githubConfig) {
      // Extract GitHub owner from full_name (format: owner/repo)
      const githubOwner = repository.fullName.split('/')[0];

      targetRepoName = await generateUniqueRepoName({
        config,
        orgName: repoOwner,
        baseName: repository.name,
        githubOwner,
        strategy: config.githubConfig.starredDuplicateStrategy,
      });

      if (targetRepoName !== repository.name) {
        console.log(
          `Starred repo ${repository.fullName} will be mirrored as ${repoOwner}/${targetRepoName} to avoid naming conflict`
        );
      }
    }

    // IDEMPOTENCY CHECK: Check if this repo is already being mirrored
    const expectedLocation = `${repoOwner}/${targetRepoName}`;
    const isCurrentlyMirroring = await isRepoCurrentlyMirroring({
      config,
      repoName: targetRepoName,
      expectedLocation,
    });

    if (isCurrentlyMirroring) {
      console.log(
        `[Idempotency] Skipping ${repository.fullName} - already being mirrored to ${expectedLocation}`
      );

      // Don't throw an error, just return to allow other repos to continue
      return;
    }

    const isExisting = await isRepoPresentInGitea({
      config,
      owner: repoOwner,
      repoName: targetRepoName,
    });

    if (isExisting) {
      console.log(
        `Repository ${targetRepoName} already exists in Gitea under ${repoOwner}. Updating database status.`
      );

      // Update database to reflect that the repository is already mirrored
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("mirrored"),
          updatedAt: new Date(),
          lastMirrored: new Date(),
          errorMessage: null,
          mirroredLocation: `${repoOwner}/${targetRepoName}`,
        })
        .where(eq(repositories.id, repository.id!));

      // Append log for "mirrored" status
      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Repository ${repository.name} already exists in Gitea`,
        details: `Repository ${repository.name} was found to already exist in Gitea under ${repoOwner} and database status was updated.`,
        status: "mirrored",
      });

      console.log(
        `Repository ${repository.name} database status updated to mirrored`
      );
      return;
    }

    console.log(`Mirroring repository ${repository.name}`);

    // DOUBLE-CHECK: Final idempotency check right before updating status
    // This catches race conditions in the small window between first check and status update
    const finalCheck = await isRepoCurrentlyMirroring({
      config,
      repoName: targetRepoName,
      expectedLocation,
    });

    if (finalCheck) {
      console.log(
        `[Idempotency] Race condition detected - ${repository.fullName} is now being mirrored by another process. Skipping.`
      );
      return;
    }

    // Mark repos as "mirroring" in DB
    // CRITICAL: Set mirroredLocation NOW (not after success) so idempotency checks work
    // This becomes the "target location" - where we intend to mirror to
    // Without this, the idempotency check can't detect concurrent operations on first mirror
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirroring"),
        mirroredLocation: expectedLocation,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "mirroring" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Started mirroring repository: ${repository.name}`,
      details: `Repository ${repository.name} is now in the mirroring state.`,
      status: "mirroring",
    });

    // Use clean clone URL without embedded credentials (Forgejo 12+ security requirement)
    const cloneAddress = repository.cloneUrl;

    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/migrate`;

    // Handle organization creation if needed for single-org, preserve strategies, or starred repos
    if (repoOwner !== config.giteaConfig.defaultOwner) {
      // Need to create the organization if it doesn't exist
      try {
        await getOrCreateGiteaOrg({
          orgName: repoOwner,
          config,
        });
      } catch (orgError) {
        console.error(`Failed to create/access organization ${repoOwner}: ${orgError instanceof Error ? orgError.message : String(orgError)}`);

        // Check if we should fallback to user account
        if (orgError instanceof Error &&
            (orgError.message.includes('Permission denied') ||
             orgError.message.includes('Authentication failed') ||
             orgError.message.includes('does not have permission'))) {
          console.warn(`[Fallback] Organization creation/access failed. Attempting to mirror to user account instead.`);

          // Update the repository owner to use the user account
          repoOwner = config.giteaConfig.defaultOwner;

          // Log this fallback in the database
          await db
            .update(repositories)
            .set({
              errorMessage: `Organization creation failed, using user account. ${orgError.message}`,
              updatedAt: new Date(),
            })
            .where(eq(repositories.id, repository.id!));
        } else {
          // Re-throw if it's not a permission issue
          throw orgError;
        }
      }
    }

    // Check if repository already exists as a non-mirror
    const { getGiteaRepoInfo, handleExistingNonMirrorRepo } = await import("./gitea-enhanced");
    const existingRepo = await getGiteaRepoInfo({
      config,
      owner: repoOwner,
      repoName: targetRepoName,
    });

    if (existingRepo && !existingRepo.mirror) {
      console.log(`Repository ${targetRepoName} exists but is not a mirror. Handling...`);

      // Handle the existing non-mirror repository
      await handleExistingNonMirrorRepo({
        config,
        repository,
        repoInfo: existingRepo,
        strategy: "delete", // Can be configured: "skip", "delete", or "rename"
      });

      // After handling, proceed with mirror creation
      console.log(`Proceeding with mirror creation for ${targetRepoName}`);
    }

    // Prepare migration payload
    // For private repos, use separate auth fields instead of embedding credentials in URL
    // This is required for Forgejo 12+ which rejects URLs with embedded credentials
    // Skip wiki for starred repos if starredCodeOnly is enabled
    const shouldMirrorWiki = config.giteaConfig?.wiki &&
      !(repository.isStarred && config.githubConfig?.starredCodeOnly);

    const migratePayload: any = {
      clone_addr: cloneAddress,
      repo_name: targetRepoName,
      mirror: true,
      mirror_interval: config.giteaConfig?.mirrorInterval || "8h",
      wiki: shouldMirrorWiki || false,
      lfs: config.giteaConfig?.lfs || false,
      private: repository.isPrivate,
      repo_owner: repoOwner,
      description: "",
      service: "git",
    };

    // Add authentication for private repositories
    if (repository.isPrivate) {
      if (!config.githubConfig.token) {
        throw new Error(
          "GitHub token is required to mirror private repositories."
        );
      }
      // Use separate auth fields (required for Forgejo 12+ compatibility)
      migratePayload.auth_username = "oauth2"; // GitHub tokens work with any username
      migratePayload.auth_token = decryptedConfig.githubConfig.token;
    }

    const response = await httpPost(
      apiUrl,
      migratePayload,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    const metadataState = parseRepositoryMetadataState(repository.metadata);
    let metadataUpdated = false;
    const skipMetadataForStarred =
      repository.isStarred && config.githubConfig?.starredCodeOnly;

    // Mirror releases if enabled (always allowed to rerun for updates)
    const shouldMirrorReleases =
      !!config.giteaConfig?.mirrorReleases && !skipMetadataForStarred;

    console.log(
      `[Metadata] Release mirroring check: mirrorReleases=${config.giteaConfig?.mirrorReleases}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorReleases=${shouldMirrorReleases}`
    );

    if (shouldMirrorReleases) {
      try {
        await mirrorGitHubReleasesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.releases = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored releases for ${repository.name}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror releases for ${repository.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other operations even if releases fail
      }
    }

    // Determine metadata operations to avoid duplicates
    const shouldMirrorIssuesThisRun =
      !!config.giteaConfig?.mirrorIssues &&
      !skipMetadataForStarred &&
      !metadataState.components.issues;

    console.log(
      `[Metadata] Issue mirroring check: mirrorIssues=${config.giteaConfig?.mirrorIssues}, alreadyMirrored=${metadataState.components.issues}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorIssues=${shouldMirrorIssuesThisRun}`
    );

    // Check for incremental sync for issues
    const issuesSinceTimestamp = metadataState.componentLastSynced?.issues;
    const shouldMirrorIssuesIncremental =
      !!config.giteaConfig?.mirrorIssues &&
      !skipMetadataForStarred &&
      metadataState.components.issues &&
      issuesSinceTimestamp;

    if (shouldMirrorIssuesThisRun || shouldMirrorIssuesIncremental) {
      try {
        await mirrorGitRepoIssuesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
          giteaRepoName: targetRepoName,
          sinceTimestamp: shouldMirrorIssuesIncremental ? issuesSinceTimestamp : undefined,
        });
        metadataState.components.issues = true;
        metadataState.components.labels = true;
        // Update timestamp for incremental sync
        if (!metadataState.componentLastSynced) {
          metadataState.componentLastSynced = {};
        }
        metadataState.componentLastSynced.issues = new Date().toISOString();
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored issues for ${repository.name}${shouldMirrorIssuesIncremental ? ' (incremental)' : ''}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror issues for ${repository.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if issues fail
      }
    } else if (config.giteaConfig?.mirrorIssues && metadataState.components.issues) {
      console.log(
        `[Metadata] Issues already mirrored for ${repository.name}; skipping (will use incremental sync on next sync)`
      );
    }

    const shouldMirrorPullRequests =
      !!config.giteaConfig?.mirrorPullRequests &&
      !skipMetadataForStarred &&
      !metadataState.components.pullRequests;

    console.log(
      `[Metadata] Pull request mirroring check: mirrorPullRequests=${config.giteaConfig?.mirrorPullRequests}, alreadyMirrored=${metadataState.components.pullRequests}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorPullRequests=${shouldMirrorPullRequests}`
    );

    // Check for incremental sync for PRs
    const prsSinceTimestamp = metadataState.componentLastSynced?.pullRequests;
    const shouldMirrorPullRequestsIncremental =
      !!config.giteaConfig?.mirrorPullRequests &&
      !skipMetadataForStarred &&
      metadataState.components.pullRequests &&
      prsSinceTimestamp;

    if (shouldMirrorPullRequests || shouldMirrorPullRequestsIncremental) {
      try {
        await mirrorGitRepoPullRequestsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
          giteaRepoName: targetRepoName,
          sinceTimestamp: shouldMirrorPullRequestsIncremental ? prsSinceTimestamp : undefined,
        });
        metadataState.components.pullRequests = true;
        // Update timestamp for incremental sync
        if (!metadataState.componentLastSynced) {
          metadataState.componentLastSynced = {};
        }
        metadataState.componentLastSynced.pullRequests = new Date().toISOString();
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored pull requests for ${repository.name}${shouldMirrorPullRequestsIncremental ? ' (incremental)' : ''}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror pull requests for ${repository.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if PRs fail
      }
    } else if (
      config.giteaConfig?.mirrorPullRequests &&
      metadataState.components.pullRequests
    ) {
      console.log(
        `[Metadata] Pull requests already mirrored for ${repository.name}; skipping (will use incremental sync on next sync)`
      );
    }

    const shouldMirrorLabels =
      !!config.giteaConfig?.mirrorLabels &&
      !skipMetadataForStarred &&
      !shouldMirrorIssuesThisRun &&
      !metadataState.components.labels;

    console.log(
      `[Metadata] Label mirroring check: mirrorLabels=${config.giteaConfig?.mirrorLabels}, alreadyMirrored=${metadataState.components.labels}, issuesRunning=${shouldMirrorIssuesThisRun}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorLabels=${shouldMirrorLabels}`
    );

    if (shouldMirrorLabels) {
      try {
        await mirrorGitRepoLabelsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.labels = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored labels for ${repository.name}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror labels for ${repository.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if labels fail
      }
    } else if (config.giteaConfig?.mirrorLabels && metadataState.components.labels) {
      console.log(
        `[Metadata] Labels already mirrored for ${repository.name}; skipping`
      );
    }

    const shouldMirrorMilestones =
      !!config.giteaConfig?.mirrorMilestones &&
      !skipMetadataForStarred &&
      !metadataState.components.milestones;

    console.log(
      `[Metadata] Milestone mirroring check: mirrorMilestones=${config.giteaConfig?.mirrorMilestones}, alreadyMirrored=${metadataState.components.milestones}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorMilestones=${shouldMirrorMilestones}`
    );

    if (shouldMirrorMilestones) {
      try {
        await mirrorGitRepoMilestonesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.milestones = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored milestones for ${repository.name}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror milestones for ${repository.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if milestones fail
      }
    } else if (
      config.giteaConfig?.mirrorMilestones &&
      metadataState.components.milestones
    ) {
      console.log(
        `[Metadata] Milestones already mirrored for ${repository.name}; skipping`
      );
    }

    if (metadataUpdated) {
      metadataState.lastSyncedAt = new Date().toISOString();
    }

    console.log(`Repository ${repository.name} mirrored successfully as ${targetRepoName}`);

    // Mark repos as "mirrored" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: `${repoOwner}/${targetRepoName}`,
        metadata: metadataUpdated
          ? serializeRepositoryMetadataState(metadataState)
          : repository.metadata ?? null,
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "mirrored" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Successfully mirrored repository: ${repository.name}${targetRepoName !== repository.name ? ` as ${targetRepoName}` : ''}`,
      details: `Repository ${repository.fullName} was mirrored to Gitea at ${repoOwner}/${targetRepoName}.`,
      status: "mirrored",
    });

    return response.data;
  } catch (error) {
    console.error(
      `Error while mirroring repository ${repository.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    // Mark repos as "failed" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for failure
    await createMirrorJob({
      userId: config.userId ?? "", // userId is going to be there anyways
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Failed to mirror repository: ${repository.name}`,
      details: `Repository ${repository.name} failed to mirror. Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      status: "failed",
    });
    if (error instanceof Error) {
      throw new Error(`Failed to mirror repository: ${error.message}`);
    }
    throw new Error("Failed to mirror repository: An unknown error occurred.");
  }
};

export async function getOrCreateGiteaOrg({
  orgName,
  orgId,
  config,
}: {
  orgId?: string; //db id
  orgName: string;
  config: Partial<Config>;
}): Promise<number> {
  // Import the enhanced version with retry logic
  const { getOrCreateGiteaOrgEnhanced } = await import("./gitea-enhanced");
  
  try {
    return await getOrCreateGiteaOrgEnhanced({
      orgName,
      orgId,
      config,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch (error) {
    // Re-throw with original function name for backward compatibility
    if (error instanceof Error) {
      throw new Error(`Error in getOrCreateGiteaOrg: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Generate a unique repository name for starred repos with duplicate names
 */
async function generateUniqueRepoName({
  config,
  orgName,
  baseName,
  githubOwner,
  strategy,
}: {
  config: Partial<Config>;
  orgName: string;
  baseName: string;
  githubOwner: string;
  strategy?: string;
}): Promise<string> {
  const duplicateStrategy = strategy || "suffix";

  // First check if base name is available
  const baseExists = await isRepoPresentInGitea({
    config,
    owner: orgName,
    repoName: baseName,
  });

  if (!baseExists) {
    return baseName;
  }

  // Generate name based on strategy
  let candidateName: string;
  let attempt = 0;
  const maxAttempts = 10;

  while (attempt < maxAttempts) {
    switch (duplicateStrategy) {
      case "prefix":
        // Prefix with owner: owner-reponame
        candidateName = attempt === 0
          ? `${githubOwner}-${baseName}`
          : `${githubOwner}-${baseName}-${attempt}`;
        break;

      case "owner-org":
        // This would require creating sub-organizations, not supported in this PR
        // Fall back to suffix strategy
      case "suffix":
      default:
        // Suffix with owner: reponame-owner
        candidateName = attempt === 0
          ? `${baseName}-${githubOwner}`
          : `${baseName}-${githubOwner}-${attempt}`;
        break;
    }

    const exists = await isRepoPresentInGitea({
      config,
      owner: orgName,
      repoName: candidateName,
    });

    if (!exists) {
      console.log(`Found unique name for duplicate starred repo: ${candidateName}`);
      return candidateName;
    }

    attempt++;
  }

  // SECURITY FIX: Prevent infinite duplicate creation
  // Instead of falling back to timestamp (which creates infinite duplicates),
  // throw an error to prevent hundreds of duplicate repos
  console.error(`Failed to find unique name for ${baseName} after ${maxAttempts} attempts`);
  console.error(`Organization: ${orgName}, GitHub Owner: ${githubOwner}, Strategy: ${duplicateStrategy}`);
  throw new Error(
    `Unable to generate unique repository name for "${baseName}". ` +
    `All ${maxAttempts} naming attempts resulted in conflicts. ` +
    `Please manually resolve the naming conflict or adjust your duplicate strategy.`
  );
}

export async function mirrorGitHubRepoToGiteaOrg({
  octokit,
  config,
  repository,
  giteaOrgId,
  orgName,
}: {
  octokit: Octokit;
  config: Partial<Config>;
  repository: Repository;
  giteaOrgId: number;
  orgName: string;
}) {
  try {
    if (
      !config.giteaConfig?.url ||
      !config.giteaConfig?.token ||
      !config.userId
    ) {
      throw new Error("Gitea config is required.");
    }

    // Decrypt config tokens for API usage
    const decryptedConfig = decryptConfigTokens(config as Config);

    // Determine the actual repository name to use (handle duplicates for starred repos)
    let targetRepoName = repository.name;

    if (repository.isStarred && config.githubConfig) {
      // Extract GitHub owner from full_name (format: owner/repo)
      const githubOwner = repository.fullName.split('/')[0];

      targetRepoName = await generateUniqueRepoName({
        config,
        orgName,
        baseName: repository.name,
        githubOwner,
        strategy: config.githubConfig.starredDuplicateStrategy,
      });

      if (targetRepoName !== repository.name) {
        console.log(
          `Starred repo ${repository.fullName} will be mirrored as ${orgName}/${targetRepoName} to avoid naming conflict`
        );
      }
    }

    // IDEMPOTENCY CHECK: Check if this repo is already being mirrored
    const expectedLocation = `${orgName}/${targetRepoName}`;
    const isCurrentlyMirroring = await isRepoCurrentlyMirroring({
      config,
      repoName: targetRepoName,
      expectedLocation,
    });

    if (isCurrentlyMirroring) {
      console.log(
        `[Idempotency] Skipping ${repository.fullName} - already being mirrored to ${expectedLocation}`
      );

      // Don't throw an error, just return to allow other repos to continue
      return;
    }

    const isExisting = await isRepoPresentInGitea({
      config,
      owner: orgName,
      repoName: targetRepoName,
    });

    if (isExisting) {
      console.log(
        `Repository ${targetRepoName} already exists in Gitea organization ${orgName}. Updating database status.`
      );

      // Update database to reflect that the repository is already mirrored
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("mirrored"),
          updatedAt: new Date(),
          lastMirrored: new Date(),
          errorMessage: null,
          mirroredLocation: `${orgName}/${targetRepoName}`,
        })
        .where(eq(repositories.id, repository.id!));

      // Create a mirror job log entry
      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Repository ${targetRepoName} already exists in Gitea organization ${orgName}`,
        details: `Repository ${targetRepoName} was found to already exist in Gitea organization ${orgName} and database status was updated.`,
        status: "mirrored",
      });

      console.log(
        `Repository ${targetRepoName} database status updated to mirrored in organization ${orgName}`
      );
      return;
    }

    console.log(
      `Mirroring repository ${repository.fullName} to organization ${orgName} as ${targetRepoName}`
    );

    // Use clean clone URL without embedded credentials (Forgejo 12+ security requirement)
    const cloneAddress = repository.cloneUrl;

    // DOUBLE-CHECK: Final idempotency check right before updating status
    // This catches race conditions in the small window between first check and status update
    const finalCheck = await isRepoCurrentlyMirroring({
      config,
      repoName: targetRepoName,
      expectedLocation,
    });

    if (finalCheck) {
      console.log(
        `[Idempotency] Race condition detected - ${repository.fullName} is now being mirrored by another process. Skipping.`
      );
      return;
    }

    // Mark repos as "mirroring" in DB
    // CRITICAL: Set mirroredLocation NOW (not after success) so idempotency checks work
    // This becomes the "target location" - where we intend to mirror to
    // Without this, the idempotency check can't detect concurrent operations on first mirror
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirroring"),
        mirroredLocation: expectedLocation,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id!));

    // Note: "mirroring" status events are handled by the concurrency system
    // to avoid duplicate events during batch operations

    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/migrate`;

    // Prepare migration payload
    // For private repos, use separate auth fields instead of embedding credentials in URL
    // This is required for Forgejo 12+ which rejects URLs with embedded credentials
    // Skip wiki for starred repos if starredCodeOnly is enabled
    const shouldMirrorWiki = config.giteaConfig?.wiki &&
      !(repository.isStarred && config.githubConfig?.starredCodeOnly);

    const migratePayload: any = {
      clone_addr: cloneAddress,
      uid: giteaOrgId,
      repo_name: targetRepoName,
      mirror: true,
      mirror_interval: config.giteaConfig?.mirrorInterval || "8h",
      wiki: shouldMirrorWiki || false,
      lfs: config.giteaConfig?.lfs || false,
      private: repository.isPrivate,
    };

    // Add authentication for private repositories
    if (repository.isPrivate) {
      if (!config.githubConfig?.token) {
        throw new Error(
          "GitHub token is required to mirror private repositories."
        );
      }
      // Use separate auth fields (required for Forgejo 12+ compatibility)
      migratePayload.auth_username = "oauth2"; // GitHub tokens work with any username
      migratePayload.auth_token = decryptedConfig.githubConfig.token;
    }

    const migrateRes = await httpPost(
      apiUrl,
      migratePayload,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    const metadataState = parseRepositoryMetadataState(repository.metadata);
    let metadataUpdated = false;
    const skipMetadataForStarred =
      repository.isStarred && config.githubConfig?.starredCodeOnly;

    const shouldMirrorReleases =
      !!config.giteaConfig?.mirrorReleases && !skipMetadataForStarred;

    console.log(
      `[Metadata] Release mirroring check: mirrorReleases=${config.giteaConfig?.mirrorReleases}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorReleases=${shouldMirrorReleases}`
    );

    if (shouldMirrorReleases) {
      try {
        await mirrorGitHubReleasesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.releases = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored releases for ${repository.name}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror releases for ${repository.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other operations even if releases fail
      }
    }

    const shouldMirrorIssuesThisRun =
      !!config.giteaConfig?.mirrorIssues &&
      !skipMetadataForStarred &&
      !metadataState.components.issues;

    console.log(
      `[Metadata] Issue mirroring check: mirrorIssues=${config.giteaConfig?.mirrorIssues}, alreadyMirrored=${metadataState.components.issues}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorIssues=${shouldMirrorIssuesThisRun}`
    );

    // Check for incremental sync for issues
    const issuesSinceTimestamp = metadataState.componentLastSynced?.issues;
    const shouldMirrorIssuesIncremental =
      !!config.giteaConfig?.mirrorIssues &&
      !skipMetadataForStarred &&
      metadataState.components.issues &&
      issuesSinceTimestamp;

    if (shouldMirrorIssuesThisRun || shouldMirrorIssuesIncremental) {
      try {
        await mirrorGitRepoIssuesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
          giteaRepoName: targetRepoName,
          sinceTimestamp: shouldMirrorIssuesIncremental ? issuesSinceTimestamp : undefined,
        });
        metadataState.components.issues = true;
        metadataState.components.labels = true;
        // Update timestamp for incremental sync
        if (!metadataState.componentLastSynced) {
          metadataState.componentLastSynced = {};
        }
        metadataState.componentLastSynced.issues = new Date().toISOString();
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored issues for ${repository.name} to org ${orgName}/${targetRepoName}${shouldMirrorIssuesIncremental ? ' (incremental)' : ''}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror issues for ${repository.name} to org ${orgName}/${targetRepoName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if issues fail
      }
    } else if (
      config.giteaConfig?.mirrorIssues &&
      metadataState.components.issues
    ) {
      console.log(
        `[Metadata] Issues already mirrored for ${repository.name}; skipping (will use incremental sync on next sync)`
      );
    }

    const shouldMirrorPullRequests =
      !!config.giteaConfig?.mirrorPullRequests &&
      !skipMetadataForStarred &&
      !metadataState.components.pullRequests;

    console.log(
      `[Metadata] Pull request mirroring check: mirrorPullRequests=${config.giteaConfig?.mirrorPullRequests}, alreadyMirrored=${metadataState.components.pullRequests}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorPullRequests=${shouldMirrorPullRequests}`
    );

    // Check for incremental sync for PRs
    const prsSinceTimestamp = metadataState.componentLastSynced?.pullRequests;
    const shouldMirrorPullRequestsIncremental =
      !!config.giteaConfig?.mirrorPullRequests &&
      !skipMetadataForStarred &&
      metadataState.components.pullRequests &&
      prsSinceTimestamp;

    if (shouldMirrorPullRequests || shouldMirrorPullRequestsIncremental) {
      try {
        await mirrorGitRepoPullRequestsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
          giteaRepoName: targetRepoName,
          sinceTimestamp: shouldMirrorPullRequestsIncremental ? prsSinceTimestamp : undefined,
        });
        metadataState.components.pullRequests = true;
        // Update timestamp for incremental sync
        if (!metadataState.componentLastSynced) {
          metadataState.componentLastSynced = {};
        }
        metadataState.componentLastSynced.pullRequests = new Date().toISOString();
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored pull requests for ${repository.name} to org ${orgName}/${targetRepoName}${shouldMirrorPullRequestsIncremental ? ' (incremental)' : ''}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror pull requests for ${repository.name} to org ${orgName}/${targetRepoName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if PRs fail
      }
    } else if (
      config.giteaConfig?.mirrorPullRequests &&
      metadataState.components.pullRequests
    ) {
      console.log(
        `[Metadata] Pull requests already mirrored for ${repository.name}; skipping (will use incremental sync on next sync)`
      );
    }

    const shouldMirrorLabels =
      !!config.giteaConfig?.mirrorLabels &&
      !skipMetadataForStarred &&
      !shouldMirrorIssuesThisRun &&
      !metadataState.components.labels;

    console.log(
      `[Metadata] Label mirroring check: mirrorLabels=${config.giteaConfig?.mirrorLabels}, alreadyMirrored=${metadataState.components.labels}, issuesRunning=${shouldMirrorIssuesThisRun}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorLabels=${shouldMirrorLabels}`
    );

    if (shouldMirrorLabels) {
      try {
        await mirrorGitRepoLabelsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.labels = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored labels for ${repository.name} to org ${orgName}/${targetRepoName}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror labels for ${repository.name} to org ${orgName}/${targetRepoName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if labels fail
      }
    } else if (
      config.giteaConfig?.mirrorLabels &&
      metadataState.components.labels
    ) {
      console.log(
        `[Metadata] Labels already mirrored for ${repository.name}; skipping`
      );
    }

    const shouldMirrorMilestones =
      !!config.giteaConfig?.mirrorMilestones &&
      !skipMetadataForStarred &&
      !metadataState.components.milestones;

    console.log(
      `[Metadata] Milestone mirroring check: mirrorMilestones=${config.giteaConfig?.mirrorMilestones}, alreadyMirrored=${metadataState.components.milestones}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorMilestones=${shouldMirrorMilestones}`
    );

    if (shouldMirrorMilestones) {
      try {
        await mirrorGitRepoMilestonesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.milestones = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored milestones for ${repository.name} to org ${orgName}/${targetRepoName}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror milestones for ${repository.name} to org ${orgName}/${targetRepoName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if milestones fail
      }
    } else if (
      config.giteaConfig?.mirrorMilestones &&
      metadataState.components.milestones
    ) {
      console.log(
        `[Metadata] Milestones already mirrored for ${repository.name}; skipping`
      );
    }

    if (metadataUpdated) {
      metadataState.lastSyncedAt = new Date().toISOString();
    }

    console.log(
      `Repository ${repository.name} mirrored successfully to organization ${orgName} as ${targetRepoName}`
    );

    // Mark repos as "mirrored" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: `${orgName}/${targetRepoName}`,
        metadata: metadataUpdated
          ? serializeRepositoryMetadataState(metadataState)
          : repository.metadata ?? null,
      })
      .where(eq(repositories.id, repository.id!));

    //create a mirror job
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Repository ${repository.name} mirrored successfully${targetRepoName !== repository.name ? ` as ${targetRepoName}` : ''}`,
      details: `Repository ${repository.fullName} was mirrored to Gitea at ${orgName}/${targetRepoName}`,
      status: "mirrored",
    });

    return migrateRes.data;
  } catch (error) {
    console.error(
      `Error while mirroring repository ${repository.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    // Mark repos as "failed" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for failure
    await createMirrorJob({
      userId: config.userId || "", // userId is going to be there anyways
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Failed to mirror repository: ${repository.name}`,
      details: `Repository ${repository.name} failed to mirror. Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      status: "failed",
    });
    if (error instanceof Error) {
      throw new Error(`Failed to mirror repository: ${error.message}`);
    }
    throw new Error("Failed to mirror repository: An unknown error occurred.");
  }
}

export async function mirrorGitHubOrgRepoToGiteaOrg({
  config,
  octokit,
  repository,
  orgName,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  orgName: string;
}) {
  try {
    if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
      throw new Error("Gitea config is required.");
    }

    const giteaOrgId = await getOrCreateGiteaOrg({
      orgName,
      config,
    });

    await mirrorGitHubRepoToGiteaOrg({
      octokit,
      config,
      repository,
      giteaOrgId,
      orgName,
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to mirror repository: ${error.message}`);
    }
    throw new Error("Failed to mirror repository: An unknown error occurred.");
  }
}

export async function mirrorGitHubOrgToGitea({
  organization,
  octokit,
  config,
}: {
  organization: Organization;
  octokit: Octokit;
  config: Partial<Config>;
}) {
  try {
    if (
      !config.userId ||
      !config.id ||
      !config.githubConfig?.token ||
      !config.giteaConfig?.url
    ) {
      throw new Error("Config, GitHub token and Gitea URL are required.");
    }

    console.log(`Mirroring organization ${organization.name}`);

    //mark the org as "mirroring" in DB
    await db
      .update(organizations)
      .set({
        isIncluded: true,
        status: repoStatusEnum.parse("mirroring"),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, organization.id!));

    // Append log for "mirroring" status
    await createMirrorJob({
      userId: config.userId,
      organizationId: organization.id,
      organizationName: organization.name,
      message: `Started mirroring organization: ${organization.name}`,
      details: `Organization ${organization.name} is now in the mirroring state.`,
      status: repoStatusEnum.parse("mirroring"),
    });

    // Get the mirror strategy - use preserveOrgStructure for backward compatibility
    const mirrorStrategy = config.githubConfig?.mirrorStrategy ||
      (config.giteaConfig?.preserveOrgStructure ? "preserve" : "flat-user");

    let giteaOrgId: number;
    let targetOrgName: string;

    // Determine the target organization based on strategy
    if (mirrorStrategy === "single-org" && config.giteaConfig?.organization) {
      // For single-org strategy, use the configured destination organization
      targetOrgName = config.giteaConfig.organization || config.giteaConfig.defaultOwner;
      giteaOrgId = await getOrCreateGiteaOrg({
        orgId: organization.id,
        orgName: targetOrgName,
        config,
      });
      console.log(`Using single organization strategy: all repos will go to ${targetOrgName}`);
    } else if (mirrorStrategy === "preserve") {
      // For preserve strategy, create/use an org with the same name as GitHub
      targetOrgName = organization.name;
      giteaOrgId = await getOrCreateGiteaOrg({
        orgId: organization.id,
        orgName: targetOrgName,
        config,
      });
    } else {
      // For flat-user strategy, we shouldn't create organizations at all
      // Skip organization creation and let individual repos be handled by getGiteaRepoOwner
      console.log(`Using flat-user strategy: repos will be placed under user account`);
      targetOrgName = config.giteaConfig?.defaultOwner || "";
    }

    //query the db with the org name and get the repos
    const orgRepos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.organization, organization.name));

    if (orgRepos.length === 0) {
      console.log(
        `No repositories found for organization ${organization.name} - marking as successfully mirrored`
      );
    } else {
      console.log(
        `Mirroring ${orgRepos.length} repositories for organization ${organization.name}`
      );

      // Import the processWithRetry function
      const { processWithRetry } = await import("@/lib/utils/concurrency");

      // Process repositories in parallel with concurrency control
      await processWithRetry(
        orgRepos,
        async (repo) => {
          // Prepare repository data
          const repoData = {
            ...repo,
            status: repo.status as RepoStatus,
            visibility: repo.visibility as RepositoryVisibility,
            lastMirrored: repo.lastMirrored ?? undefined,
            errorMessage: repo.errorMessage ?? undefined,
            organization: repo.organization ?? undefined,
            forkedFrom: repo.forkedFrom ?? undefined,
            mirroredLocation: repo.mirroredLocation || "",
          };

          // Log the start of mirroring
          console.log(
            `Starting mirror for repository: ${repo.name} from GitHub org ${organization.name}`
          );

          // Mirror the repository based on strategy
          if (mirrorStrategy === "flat-user") {
            // For flat-user strategy, mirror directly to user account
            await mirrorGithubRepoToGitea({
              octokit,
              repository: repoData,
              config,
            });
          } else {
            // For preserve and single-org strategies, use organization
            await mirrorGitHubRepoToGiteaOrg({
              octokit,
              config,
              repository: repoData,
              giteaOrgId: giteaOrgId!,
              orgName: targetOrgName,
            });
          }

          return repo;
        },
        {
          concurrencyLimit: 3, // Process 3 repositories at a time
          maxRetries: 2,
          retryDelay: 2000,
          onProgress: (completed, total, result) => {
            const percentComplete = Math.round((completed / total) * 100);
            if (result) {
              console.log(
                `Mirrored repository "${result.name}" in organization ${organization.name} (${completed}/${total}, ${percentComplete}%)`
              );
            }
          },
          onRetry: (repo, error, attempt) => {
            console.log(
              `Retrying repository ${repo.name} in organization ${organization.name} (attempt ${attempt}): ${error.message}`
            );
          },
        }
      );
    }

    console.log(`Organization ${organization.name} mirrored successfully`);

    // Mark org as "mirrored" in DB
    await db
      .update(organizations)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
      })
      .where(eq(organizations.id, organization.id!));

    // Append log for "mirrored" status
    await createMirrorJob({
      userId: config.userId,
      organizationId: organization.id,
      organizationName: organization.name,
      message: `Successfully mirrored organization: ${organization.name}`,
      details:
        orgRepos.length === 0
          ? `Organization ${organization.name} was processed successfully (no repositories found).`
          : `Organization ${organization.name} was mirrored to Gitea with ${orgRepos.length} repositories.`,
      status: repoStatusEnum.parse("mirrored"),
    });
  } catch (error) {
    console.error(
      `Error while mirroring organization ${organization.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    // Mark org as "failed" in DB
    await db
      .update(organizations)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      })
      .where(eq(organizations.id, organization.id!));

    // Append log for failure
    await createMirrorJob({
      userId: config.userId || "", // userId is going to be there anyways
      organizationId: organization.id,
      organizationName: organization.name,
      message: `Failed to mirror organization: ${organization.name}`,
      details: `Organization ${organization.name} failed to mirror. Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      status: repoStatusEnum.parse("failed"),
    });

    if (error instanceof Error) {
      throw new Error(`Failed to mirror repository: ${error.message}`);
    }
    throw new Error("Failed to mirror repository: An unknown error occurred.");
  }
}

export const syncGiteaRepo = async ({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: Repository;
}) => {
  // Use the enhanced sync function that handles non-mirror repos
  const { syncGiteaRepoEnhanced } = await import("./gitea-enhanced");
  
  try {
    return await syncGiteaRepoEnhanced({ config, repository });
  } catch (error) {
    // Re-throw with original function name for backward compatibility
    if (error instanceof Error) {
      throw new Error(`Failed to sync repository: ${error.message}`);
    }
    throw new Error("Failed to sync repository: An unknown error occurred.");
  }
};

export const mirrorGitRepoIssuesToGitea = async ({
  config,
  octokit,
  repository,
  giteaOwner,
  giteaRepoName,
  sinceTimestamp,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
  giteaRepoName?: string;
  sinceTimestamp?: string;
}) => {
  //things covered here are- issue, title, body, labels, comments and assignees
  if (
    !config.githubConfig?.token ||
    !config.giteaConfig?.token ||
    !config.giteaConfig?.url ||
    !config.giteaConfig?.defaultOwner
  ) {
    throw new Error("Missing GitHub or Gitea configuration.");
  }

  // Decrypt config tokens for API usage
  const decryptedConfig = decryptConfigTokens(config as Config);
  
  // Use provided giteaRepoName or fall back to repository.name
  const repoName = giteaRepoName || repository.name;
  
  // Log configuration details for debugging
  console.log(`[Issues] Starting issue mirroring for repository ${repository.name} as ${repoName}`);
  console.log(`[Issues] Gitea URL: ${config.giteaConfig!.url}`);
  console.log(`[Issues] Gitea Owner: ${giteaOwner}`);
  console.log(`[Issues] Gitea Default Owner: ${config.giteaConfig!.defaultOwner}`);
  
  // Verify the repository exists in Gitea before attempting to mirror metadata
  console.log(`[Issues] Verifying repository ${repoName} exists at ${giteaOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: giteaOwner,
    repoName: repoName,
  });
  
  if (!repoExists) {
    console.error(`[Issues] Repository ${repoName} not found at ${giteaOwner}. Cannot mirror issues.`);
    throw new Error(`Repository ${repoName} does not exist in Gitea at ${giteaOwner}. Please ensure the repository is mirrored first.`);
  }

  const [owner, repo] = repository.fullName.split("/");

  // Fetch GitHub issues (with incremental sync support)
  const isIncrementalSync = !!sinceTimestamp;
  const fetchParams: any = {
    owner,
    repo,
    state: "all",
    per_page: 100,
    sort: isIncrementalSync ? "updated" : "created",
    direction: "asc",
  };

  // Add 'since' parameter for incremental sync
  if (sinceTimestamp) {
    fetchParams.since = sinceTimestamp;
    console.log(
      `[Issues] Incremental sync: fetching issues updated since ${sinceTimestamp}`
    );
  } else {
    console.log(`[Issues] Full sync: fetching all issues`);
  }

  const issues = await octokit.paginate(
    octokit.rest.issues.listForRepo,
    fetchParams,
    (res) => res.data
  );

  // Filter out pull requests
  const filteredIssues = issues.filter((issue) => !(issue as any).pull_request);

  console.log(
    `Mirroring ${filteredIssues.length} issues from ${repository.fullName}`
  );

  if (filteredIssues.length === 0) {
    console.log(`No ${isIncrementalSync ? 'new or updated ' : ''}issues to mirror for ${repository.fullName}`);
    return;
  }

  // For incremental sync, fetch existing Gitea issues to avoid duplicates
  const existingGiteaIssues = new Set<string>();
  if (isIncrementalSync) {
    try {
      console.log(`[Issues] Fetching existing Gitea issues updated since ${sinceTimestamp} to check for duplicates`);
      // Fetch with pagination to handle repos with >1000 issues
      // Use 'since' parameter to only fetch recently updated issues for more efficient duplicate detection
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const giteaIssuesRes = await httpGet<any[]>(
          `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/issues?state=all&since=${sinceTimestamp}&page=${page}&limit=100`,
          {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
          }
        );

        if (giteaIssuesRes.data.length === 0) {
          hasMore = false;
          break;
        }

        // Store issue titles to match against (excludes PR issues which have [PR #] prefix)
        for (const giteaIssue of giteaIssuesRes.data) {
          // Skip PR issues - they're handled separately
          if (!giteaIssue.title.startsWith('[PR #')) {
            existingGiteaIssues.add(giteaIssue.title);
          }
        }

        // Stop after first page for performance (most recent issues)
        if (giteaIssuesRes.data.length < 100) {
          hasMore = false;
        } else {
          page++;
          // Safety limit: don't fetch more than 10 pages (1000 issues)
          if (page > 10) {
            console.warn(`[Issues] Stopped duplicate check after 1000 issues for performance`);
            hasMore = false;
          }
        }
      }

      console.log(`[Issues] Found ${existingGiteaIssues.size} existing issues in Gitea`);
    } catch (error) {
      console.warn(`[Issues] Failed to fetch existing Gitea issues: ${error instanceof Error ? error.message : String(error)}`);
      // Continue anyway - worst case we might create duplicates
    }
  }

  // Get existing labels from Gitea
  const giteaLabelsRes = await httpGet(
    `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/labels`,
    {
      Authorization: `token ${decryptedConfig.giteaConfig.token}`,
    }
  );

  const giteaLabels = giteaLabelsRes.data;
  const labelMap = new Map<string, number>(
    giteaLabels.map((label: any) => [label.name, label.id])
  );

  // Import the processWithRetry function
  const { processWithRetry } = await import("@/lib/utils/concurrency");

  const rawIssueConcurrency = config.giteaConfig?.issueConcurrency ?? 3;
  const issueConcurrencyLimit =
    Number.isFinite(rawIssueConcurrency)
      ? Math.max(1, Math.floor(rawIssueConcurrency))
      : 1;

  if (issueConcurrencyLimit > 1) {
    console.warn(
      `[Issues] Concurrency is set to ${issueConcurrencyLimit}. This may lead to out-of-order issue creation in Gitea but is faster.`
    );
  }

  // Process issues in parallel with concurrency control
  let skippedCount = 0;
  await processWithRetry(
    filteredIssues,
    async (issue) => {
      // Skip if issue already exists during incremental sync
      if (isIncrementalSync && existingGiteaIssues.has(issue.title)) {
        console.log(`[Issues] Skipping existing issue: "${issue.title}"`);
        skippedCount++;
        return issue;
      }

      const githubLabelNames =
        issue.labels
          ?.map((l) => (typeof l === "string" ? l : l.name))
          .filter((l): l is string => !!l) || [];

      const giteaLabelIds: number[] = [];

      // Resolve or create labels in Gitea
      for (const name of githubLabelNames) {
        if (labelMap.has(name)) {
          giteaLabelIds.push(labelMap.get(name)!);
        } else {
          try {
            const created = await httpPost(
              `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/labels`,
              { name, color: "#ededed" }, // Default color
              {
                Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
              }
            );

            labelMap.set(name, created.data.id);
            giteaLabelIds.push(created.data.id);
          } catch (labelErr) {
            console.error(
              `Failed to create label "${name}" in Gitea: ${labelErr}`
            );
          }
        }
      }

      const originalAssignees =
        issue.assignees && issue.assignees.length > 0
          ? `\n\nOriginally assigned to: ${issue.assignees
              .map((a) => `@${a.login}`)
              .join(", ")} on GitHub.`
          : "";

      const issueAuthor = issue.user?.login ?? "unknown";
      const issueCreatedOn = formatDateShort(issue.created_at);
      const issueOriginHeader = `Originally created by @${issueAuthor} on GitHub${
        issueCreatedOn ? ` (${issueCreatedOn})` : ""
      }.`;

      const issuePayload: any = {
        title: issue.title,
        body: `${issueOriginHeader}${originalAssignees}\n\n${issue.body ?? ""}`,
        closed: issue.state === "closed",
        labels: giteaLabelIds,
      };

      // Create the issue in Gitea
      const createdIssue = await httpPost(
        `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues`,
        issuePayload,
        {
          Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
        }
      );

      // Clone comments
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner,
          repo,
          issue_number: issue.number,
          per_page: 100,
        },
        (res) => res.data
      );

      // Ensure comments are applied in chronological order to preserve discussion flow
      const sortedComments = comments
        .slice()
        .sort(
          (a, b) =>
            new Date(a.created_at || 0).getTime() -
            new Date(b.created_at || 0).getTime()
        );

      // Process comments sequentially to preserve historical ordering
      if (sortedComments.length > 0) {
        await processWithRetry(
          sortedComments,
          async (comment) => {
            const commenter = comment.user?.login ?? "unknown";
            const commentDate = formatDateShort(comment.created_at);
            const commentHeader = `@${commenter} commented on GitHub${
              commentDate ? ` (${commentDate})` : ""
            }:`;

            await httpPost(
              `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${createdIssue.data.number}/comments`,
              {
                body: `${commentHeader}\n\n${comment.body ?? ""}`,
              },
              {
                Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
              }
            );
            return comment;
          },
          {
            concurrencyLimit: 1,
            maxRetries: 2,
            retryDelay: 1000,
            onRetry: (_comment, error, attempt) => {
              console.log(
                `Retrying comment (attempt ${attempt}): ${error.message}`
              );
            },
          }
        );
      }

      return issue;
    },
    {
      concurrencyLimit: issueConcurrencyLimit,
      maxRetries: 2,
      retryDelay: 2000,
      onProgress: (completed, total, result) => {
        const percentComplete = Math.round((completed / total) * 100);
        if (result) {
          console.log(
            `Mirrored issue "${result.title}" (${completed}/${total}, ${percentComplete}%)`
          );
        }
      },
      onRetry: (issue, error, attempt) => {
        console.log(
          `Retrying issue "${issue.title}" (attempt ${attempt}): ${error.message}`
        );
      },
    }
  );

  const newIssuesCount = filteredIssues.length - skippedCount;
  console.log(
    `Completed mirroring ${newIssuesCount} ${isIncrementalSync ? 'new ' : ''}issues for ${repository.fullName}${isIncrementalSync && skippedCount > 0 ? ` (${skippedCount} already existed)` : ''}`
  );
};

export async function mirrorGitHubReleasesToGitea({
  octokit,
  repository,
  config,
  giteaOwner,
  giteaRepoName,
}: {
  octokit: Octokit;
  repository: Repository;
  config: Partial<Config>;
  giteaOwner?: string;
  giteaRepoName?: string;
}) {
  if (
    !config.giteaConfig?.defaultOwner ||
    !config.giteaConfig?.token ||
    !config.giteaConfig?.url
  ) {
    throw new Error("Gitea config is incomplete for mirroring releases.");
  }

  // Decrypt config tokens for API usage
  const decryptedConfig = decryptConfigTokens(config as Config);

  // Determine target owner/repo in Gitea (supports renamed repos)
  const repoOwner = giteaOwner || (await getGiteaRepoOwnerAsync({ config, repository }));
  const repoName = giteaRepoName || repository.name;

  // Verify the repository exists in Gitea before attempting to mirror releases
  console.log(`[Releases] Verifying repository ${repoName} exists at ${repoOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: repoOwner,
    repoName: repoName,
  });
  
  if (!repoExists) {
    console.error(`[Releases] Repository ${repository.name} not found at ${repoOwner}. Cannot mirror releases.`);
    throw new Error(`Repository ${repository.name} does not exist in Gitea at ${repoOwner}. Please ensure the repository is mirrored first.`);
  }

  // Get release limit from config (default to 10)
  const releaseLimit = config.giteaConfig?.releaseLimit || 10;
  
  const releases = await octokit.rest.repos.listReleases({
    owner: repository.owner,
    repo: repository.name,
    per_page: releaseLimit, // Only fetch the latest N releases
  });

  console.log(`[Releases] Found ${releases.data.length} releases (limited to latest ${releaseLimit}) to mirror for ${repository.fullName}`);

  if (releases.data.length === 0) {
    console.log(`[Releases] No releases to mirror for ${repository.fullName}`);
    return;
  }

  let mirroredCount = 0;
  let skippedCount = 0;

  const getReleaseTimestamp = (release: typeof releases.data[number]) => {
    // Use published_at first (when the release was published on GitHub)
    // Fall back to created_at (when the git tag was created) only if published_at is missing
    // This matches GitHub's sorting behavior and handles cases where multiple tags
    // point to the same commit but have different publish dates
    const sourceDate = release.published_at ?? release.created_at ?? "";
    const timestamp = sourceDate ? new Date(sourceDate).getTime() : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
  };

  // Capture the latest releases, then process them oldest-to-newest so Gitea mirrors keep chronological order
  const releasesToProcess = releases.data
    .slice()
    .sort((a, b) => getReleaseTimestamp(b) - getReleaseTimestamp(a))
    .slice(0, releaseLimit)
    .sort((a, b) => getReleaseTimestamp(a) - getReleaseTimestamp(b));

  console.log(`[Releases] Processing ${releasesToProcess.length} releases in chronological order (oldest to newest by published date)`);
  releasesToProcess.forEach((rel, idx) => {
    const publishedDate = new Date(rel.published_at || rel.created_at);
    const createdDate = new Date(rel.created_at);
    const dateInfo = rel.published_at !== rel.created_at
      ? `published ${publishedDate.toISOString()} (tag created ${createdDate.toISOString()})`
      : `published ${publishedDate.toISOString()}`;
    console.log(`[Releases] ${idx + 1}. ${rel.tag_name} - ${dateInfo}`);
  });

  // Check if existing releases in Gitea are in the wrong order
  // If so, we need to delete and recreate them to fix the ordering
  let needsRecreation = false;
  try {
    const existingReleasesResponse = await httpGet(
      `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases?per_page=100`,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    ).catch(() => null);

    if (existingReleasesResponse && existingReleasesResponse.data && Array.isArray(existingReleasesResponse.data)) {
      const existingReleases = existingReleasesResponse.data;

      if (existingReleases.length > 0) {
        console.log(`[Releases] Found ${existingReleases.length} existing releases in Gitea, checking chronological order...`);

        // Create a map of tag_name to expected chronological index (0 = oldest, n = newest)
        const expectedOrder = new Map<string, number>();
        releasesToProcess.forEach((rel, idx) => {
          expectedOrder.set(rel.tag_name, idx);
        });

        // Check if existing releases are in the correct order based on created_unix
        // Gitea sorts by created_unix DESC, so newer releases should have higher created_unix values
        const releasesThatShouldExist = existingReleases.filter(r => expectedOrder.has(r.tag_name));

        if (releasesThatShouldExist.length > 1) {
          for (let i = 0; i < releasesThatShouldExist.length - 1; i++) {
            const current = releasesThatShouldExist[i];
            const next = releasesThatShouldExist[i + 1];

            const currentExpectedIdx = expectedOrder.get(current.tag_name)!;
            const nextExpectedIdx = expectedOrder.get(next.tag_name)!;

            // Since Gitea returns releases sorted by created_unix DESC:
            // - Earlier releases in the list should have HIGHER expected indices (newer)
            // - Later releases in the list should have LOWER expected indices (older)
            if (currentExpectedIdx < nextExpectedIdx) {
              console.log(`[Releases] ⚠️  Incorrect ordering detected: ${current.tag_name} (index ${currentExpectedIdx}) appears before ${next.tag_name} (index ${nextExpectedIdx})`);
              needsRecreation = true;
              break;
            }
          }
        }

        if (needsRecreation) {
          console.log(`[Releases] ⚠️  Releases are in incorrect chronological order. Will delete and recreate all releases.`);

          // Delete all existing releases that we're about to recreate
          for (const existingRelease of releasesThatShouldExist) {
            try {
              console.log(`[Releases] Deleting incorrectly ordered release: ${existingRelease.tag_name}`);
              await httpDelete(
                `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases/${existingRelease.id}`,
                {
                  Authorization: `token ${decryptedConfig.giteaConfig.token}`,
                }
              );
            } catch (deleteError) {
              console.error(`[Releases] Failed to delete release ${existingRelease.tag_name}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
            }
          }

          console.log(`[Releases] ✅ Deleted ${releasesThatShouldExist.length} releases. Will recreate in correct chronological order.`);
        } else {
          console.log(`[Releases] ✅ Existing releases are in correct chronological order.`);
        }
      }
    }
  } catch (orderCheckError) {
    console.warn(`[Releases] Could not verify release order: ${orderCheckError instanceof Error ? orderCheckError.message : String(orderCheckError)}`);
    // Continue with normal processing
  }

  for (const release of releasesToProcess) {
    try {
      // Check if release already exists (skip check if we just deleted all releases)
      const existingReleasesResponse = needsRecreation ? null : await httpGet(
        `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases/tags/${release.tag_name}`,
        {
          Authorization: `token ${decryptedConfig.giteaConfig.token}`,
        }
      ).catch(() => null);

      // Prepare release body with GitHub original date header
      const githubPublishedDate = release.published_at || release.created_at;
      const githubTagCreatedDate = release.created_at;

      let githubDateHeader = '';
      if (githubPublishedDate) {
        githubDateHeader = `> 📅 **Originally published on GitHub:** ${new Date(githubPublishedDate).toUTCString()}`;

        // If the tag was created on a different date than the release was published,
        // show both dates (helps with repos that create multiple tags from the same commit)
        if (release.published_at && release.created_at && release.published_at !== release.created_at) {
          githubDateHeader += `\n> 🏷️  **Git tag created:** ${new Date(githubTagCreatedDate).toUTCString()}`;
        }

        githubDateHeader += '\n\n';
      }

      const originalReleaseNote = release.body || "";
      const releaseNote = githubDateHeader + originalReleaseNote;

      if (existingReleasesResponse) {
        // Update existing release if the changelog/body differs
        const existingRelease = existingReleasesResponse.data;
        const existingNote = existingRelease.body || "";
        
        if (existingNote !== releaseNote || existingRelease.name !== (release.name || release.tag_name)) {
          console.log(`[Releases] Updating existing release ${release.tag_name} with new changelog/title`);
          
          await httpPut(
            `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases/${existingRelease.id}`,
            {
              tag_name: release.tag_name,
              target: release.target_commitish,
              title: release.name || release.tag_name,
              body: releaseNote,
              draft: release.draft,
              prerelease: release.prerelease,
            },
            {
              Authorization: `token ${decryptedConfig.giteaConfig.token}`,
            }
          );

          if (originalReleaseNote) {
            console.log(`[Releases] Updated changelog for ${release.tag_name} (${originalReleaseNote.length} characters + GitHub date header)`);
          } else {
            console.log(`[Releases] Updated release ${release.tag_name} with GitHub date header`);
          }
          mirroredCount++;
        } else {
          console.log(`[Releases] Release ${release.tag_name} already up-to-date, skipping`);
          skippedCount++;
        }
        continue;
      }

      // Create new release with changelog/body content (includes GitHub date header)
      if (originalReleaseNote) {
        console.log(`[Releases] Including changelog for ${release.tag_name} (${originalReleaseNote.length} characters + GitHub date header)`);
      } else {
        console.log(`[Releases] Creating release ${release.tag_name} with GitHub date header (no changelog)`);
      }
      
      const createReleaseResponse = await httpPost(
        `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases`,
        {
          tag_name: release.tag_name,
          target: release.target_commitish,
          title: release.name || release.tag_name,
          body: releaseNote,
          draft: release.draft,
          prerelease: release.prerelease,
        },
        {
          Authorization: `token ${decryptedConfig.giteaConfig.token}`,
        }
      );
      
      // Mirror release assets if they exist
      if (release.assets && release.assets.length > 0) {
        console.log(`[Releases] Mirroring ${release.assets.length} assets for release ${release.tag_name}`);
        
        for (const asset of release.assets) {
          try {
            // Download the asset from GitHub
            console.log(`[Releases] Downloading asset: ${asset.name} (${asset.size} bytes)`);
            const assetResponse = await fetch(asset.browser_download_url, {
              headers: {
                'Accept': 'application/octet-stream',
                'Authorization': `token ${decryptedConfig.githubConfig.token}`,
              },
            });
            
            if (!assetResponse.ok) {
              console.error(`[Releases] Failed to download asset ${asset.name}: ${assetResponse.statusText}`);
              continue;
            }
            
            const assetData = await assetResponse.arrayBuffer();
            
            // Upload the asset to Gitea release
            const formData = new FormData();
            formData.append('attachment', new Blob([assetData]), asset.name);
            
            const uploadResponse = await fetch(
              `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases/${createReleaseResponse.data.id}/assets?name=${encodeURIComponent(asset.name)}`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `token ${decryptedConfig.giteaConfig.token}`,
                },
                body: formData,
              }
            );
            
            if (uploadResponse.ok) {
              console.log(`[Releases] Successfully uploaded asset: ${asset.name}`);
            } else {
              const errorText = await uploadResponse.text();
              console.error(`[Releases] Failed to upload asset ${asset.name}: ${errorText}`);
            }
          } catch (assetError) {
            console.error(`[Releases] Error processing asset ${asset.name}: ${assetError instanceof Error ? assetError.message : String(assetError)}`);
          }
        }
      }
      
      mirroredCount++;
      const noteInfo = originalReleaseNote ? ` with ${originalReleaseNote.length} character changelog` : " without changelog";
      console.log(`[Releases] Successfully mirrored release: ${release.tag_name}${noteInfo}`);

      // Add delay to ensure proper timestamp ordering in Gitea
      // Gitea sorts releases by created_unix DESC, and all releases created in quick succession
      // will have nearly identical timestamps. The 1-second delay ensures proper chronological order.
      console.log(`[Releases] Waiting 1 second to ensure proper timestamp ordering in Gitea...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`[Releases] Failed to mirror release ${release.tag_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`✅ Mirrored/Updated ${mirroredCount} releases to Gitea (${skippedCount} already up-to-date)`);
}

export async function mirrorGitRepoPullRequestsToGitea({
  config,
  octokit,
  repository,
  giteaOwner,
  giteaRepoName,
  sinceTimestamp,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
  giteaRepoName?: string;
  sinceTimestamp?: string;
}) {
  if (
    !config.githubConfig?.token ||
    !config.giteaConfig?.token ||
    !config.giteaConfig?.url ||
    !config.giteaConfig?.defaultOwner
  ) {
    throw new Error("Missing GitHub or Gitea configuration.");
  }

  // Decrypt config tokens for API usage
  const decryptedConfig = decryptConfigTokens(config as Config);
  
  // Use provided giteaRepoName or fall back to repository.name
  const repoName = giteaRepoName || repository.name;
  
  // Log configuration details for debugging
  console.log(`[Pull Requests] Starting PR mirroring for repository ${repository.name} as ${repoName}`);
  console.log(`[Pull Requests] Gitea URL: ${config.giteaConfig!.url}`);
  console.log(`[Pull Requests] Gitea Owner: ${giteaOwner}`);
  console.log(`[Pull Requests] Gitea Default Owner: ${config.giteaConfig!.defaultOwner}`);
  
  // Verify the repository exists in Gitea before attempting to mirror metadata
  console.log(`[Pull Requests] Verifying repository ${repoName} exists at ${giteaOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: giteaOwner,
    repoName: repoName,
  });
  
  if (!repoExists) {
    console.error(`[Pull Requests] Repository ${repoName} not found at ${giteaOwner}. Cannot mirror PRs.`);
    throw new Error(`Repository ${repoName} does not exist in Gitea at ${giteaOwner}. Please ensure the repository is mirrored first.`);
  }

  const [owner, repo] = repository.fullName.split("/");

  // Fetch GitHub pull requests
  const isIncrementalSync = !!sinceTimestamp;
  if (sinceTimestamp) {
    console.log(
      `[Pull Requests] Incremental sync: filtering PRs updated since ${sinceTimestamp}`
    );
  } else {
    console.log(`[Pull Requests] Full sync: fetching all pull requests`);
  }

  const pullRequests = await octokit.paginate(
    octokit.rest.pulls.list,
    {
      owner,
      repo,
      state: "all",
      per_page: 100,
      sort: isIncrementalSync ? "updated" : "created",
      direction: "desc", // Get newest first for incremental sync
    },
    (res) => res.data
  );

  // Filter PRs by update time if doing incremental sync
  let filteredPRs = pullRequests;
  if (sinceTimestamp) {
    const sinceDate = new Date(sinceTimestamp);
    filteredPRs = pullRequests.filter(pr => {
      const prUpdatedAt = new Date(pr.updated_at);
      return prUpdatedAt > sinceDate;
    });
    console.log(
      `[Pull Requests] Filtered to ${filteredPRs.length} PRs updated since ${sinceTimestamp} (from ${pullRequests.length} total)`
    );
  }

  console.log(
    `Mirroring ${filteredPRs.length} pull requests from ${repository.fullName}`
  );

  if (filteredPRs.length === 0) {
    console.log(`No ${isIncrementalSync ? 'new or updated ' : ''}pull requests to mirror for ${repository.fullName}`);
    return;
  }

  // For incremental sync, fetch existing Gitea issues (PRs are stored as issues) to avoid duplicates
  const existingGiteaPRNumbers = new Set<number>();
  if (isIncrementalSync) {
    try {
      console.log(`[Pull Requests] Fetching existing Gitea PR issues updated since ${sinceTimestamp} to check for duplicates`);
      // Fetch with pagination to handle repos with >1000 issues
      // Use 'since' parameter to only fetch recently updated issues for more efficient duplicate detection
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const giteaIssuesRes = await httpGet<any[]>(
          `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/issues?state=all&since=${sinceTimestamp}&page=${page}&limit=100`,
          {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
          }
        );

        if (giteaIssuesRes.data.length === 0) {
          hasMore = false;
          break;
        }

        // Extract PR numbers from titles (format: "[PR #123] ...")
        for (const giteaIssue of giteaIssuesRes.data) {
          const match = giteaIssue.title.match(/^\[PR #(\d+)\]/);
          if (match) {
            existingGiteaPRNumbers.add(parseInt(match[1], 10));
          }
        }

        // Stop after first page for performance (most recent issues)
        // Full scan only if we hit the limit
        if (giteaIssuesRes.data.length < 100) {
          hasMore = false;
        } else {
          page++;
          // Safety limit: don't fetch more than 10 pages (1000 issues)
          if (page > 10) {
            console.warn(`[Pull Requests] Stopped duplicate check after 1000 issues for performance`);
            hasMore = false;
          }
        }
      }

      console.log(`[Pull Requests] Found ${existingGiteaPRNumbers.size} existing PR issues in Gitea`);
    } catch (error) {
      console.warn(`[Pull Requests] Failed to fetch existing Gitea issues: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Note: Gitea doesn't have a direct API to create pull requests from external sources
  // Pull requests are typically created through Git operations
  // For now, we'll create them as issues with a special label
  
  // Get existing labels from Gitea and ensure "pull-request" label exists
  const giteaLabelsRes = await httpGet(
    `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/labels`,
    {
      Authorization: `token ${decryptedConfig.giteaConfig.token}`,
    }
  );

  const giteaLabels = giteaLabelsRes.data;
  const labelMap = new Map<string, number>(
    giteaLabels.map((label: any) => [label.name, label.id])
  );

  // Ensure "pull-request" label exists
  let pullRequestLabelId: number | null = null;
  if (labelMap.has("pull-request")) {
    pullRequestLabelId = labelMap.get("pull-request")!;
  } else {
    try {
      const created = await httpPost(
        `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/labels`,
        { 
          name: "pull-request",
          color: "#0366d6",
          description: "Mirrored from GitHub Pull Request"
        },
        {
          Authorization: `token ${decryptedConfig.giteaConfig.token}`,
        }
      );
      pullRequestLabelId = created.data.id;
    } catch (error) {
      console.error(`Failed to create "pull-request" label in Gitea: ${error}`);
      // Continue without labels if creation fails
    }
  }

  const { processWithRetry } = await import("@/lib/utils/concurrency");

  const rawPullConcurrency = config.giteaConfig?.pullRequestConcurrency ?? 5;
  const pullRequestConcurrencyLimit =
    Number.isFinite(rawPullConcurrency)
      ? Math.max(1, Math.floor(rawPullConcurrency))
      : 1;

  if (pullRequestConcurrencyLimit > 1) {
    console.warn(
      `[Pull Requests] Concurrency is set to ${pullRequestConcurrencyLimit}. This may lead to out-of-order pull request mirroring in Gitea.`
    );
  }

  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  await processWithRetry(
    filteredPRs,
    async (pr) => {
      // Skip if PR already exists during incremental sync (check by PR number)
      if (isIncrementalSync && existingGiteaPRNumbers.has(pr.number)) {
        console.log(`[Pull Requests] Skipping existing PR #${pr.number}: "${pr.title}"`);
        skippedCount++;
        return;
      }

      try {
        // Fetch additional PR data for rich metadata
        const [prDetail, commits, files] = await Promise.all([
          octokit.rest.pulls.get({ owner, repo, pull_number: pr.number }),
          octokit.rest.pulls.listCommits({ owner, repo, pull_number: pr.number, per_page: 10 }),
          octokit.rest.pulls.listFiles({ owner, repo, pull_number: pr.number, per_page: 100 })
        ]);

        // Build rich PR body with metadata
        let richBody = `## 📋 Pull Request Information\n\n`;
        richBody += `**Original PR:** ${pr.html_url}\n`;
        richBody += `**Author:** [@${pr.user?.login}](${pr.user?.html_url})\n`;
        richBody += `**Created:** ${new Date(pr.created_at).toLocaleDateString()}\n`;
        richBody += `**Status:** ${pr.state === 'closed' ? (pr.merged_at ? '✅ Merged' : '❌ Closed') : '🔄 Open'}\n`;
        
        if (pr.merged_at) {
          richBody += `**Merged:** ${new Date(pr.merged_at).toLocaleDateString()}\n`;
          richBody += `**Merged by:** [@${prDetail.data.merged_by?.login}](${prDetail.data.merged_by?.html_url})\n`;
        }

        richBody += `\n**Base:** \`${pr.base.ref}\` ← **Head:** \`${pr.head.ref}\`\n`;
        richBody += `\n---\n\n`;

        // Add commit history (up to 10 commits)
        if (commits.data.length > 0) {
          richBody += `### 📝 Commits (${commits.data.length}${commits.data.length >= 10 ? '+' : ''})\n\n`;
          commits.data.slice(0, 10).forEach(commit => {
            const shortSha = commit.sha.substring(0, 7);
            richBody += `- [\`${shortSha}\`](${commit.html_url}) ${commit.commit.message.split('\n')[0]}\n`;
          });
          if (commits.data.length > 10) {
            richBody += `\n_...and ${commits.data.length - 10} more commits_\n`;
          }
          richBody += `\n`;
        }

        // Add file changes summary
        if (files.data.length > 0) {
          const additions = prDetail.data.additions || 0;
          const deletions = prDetail.data.deletions || 0;
          const changedFiles = prDetail.data.changed_files || files.data.length;
          
          richBody += `### 📊 Changes\n\n`;
          richBody += `**${changedFiles} file${changedFiles !== 1 ? 's' : ''} changed** `;
          richBody += `(+${additions} additions, -${deletions} deletions)\n\n`;
          
          // List changed files (up to 20)
          richBody += `<details>\n<summary>View changed files</summary>\n\n`;
          files.data.slice(0, 20).forEach(file => {
            const changeIndicator = file.status === 'added' ? '➕' : 
                                   file.status === 'removed' ? '➖' : '📝';
            richBody += `${changeIndicator} \`${file.filename}\` (+${file.additions} -${file.deletions})\n`;
          });
          if (files.data.length > 20) {
            richBody += `\n_...and ${files.data.length - 20} more files_\n`;
          }
          richBody += `\n</details>\n\n`;
        }

        // Add original PR description
        richBody += `### 📄 Description\n\n`;
        richBody += pr.body || '_No description provided_';
        richBody += `\n\n---\n`;
        richBody += `\n<sub>🔄 This issue represents a GitHub Pull Request. `;
        richBody += `It cannot be merged through Gitea due to API limitations.</sub>`;

        // Prepare issue title with status indicator
        const statusPrefix = pr.merged_at ? '[MERGED] ' : (pr.state === 'closed' ? '[CLOSED] ' : '');
        const issueTitle = `[PR #${pr.number}] ${statusPrefix}${pr.title}`;

        const issueData = {
          title: issueTitle,
          body: richBody,
          labels: pullRequestLabelId ? [pullRequestLabelId] : [],
          closed: pr.state === "closed" || pr.merged_at !== null,
        };

        console.log(`[Pull Requests] Creating enriched issue for PR #${pr.number}: ${pr.title}`);
        await httpPost(
          `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues`,
          issueData,
          {
            Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
          }
        );
        successCount++;
        console.log(`[Pull Requests] ✅ Successfully created issue for PR #${pr.number}`);
      } catch (apiError) {
        // If the detailed fetch fails, fall back to basic PR info
        console.log(`[Pull Requests] Falling back to basic info for PR #${pr.number} due to error: ${apiError}`);
        const basicIssueData = {
          title: `[PR #${pr.number}] ${pr.title}`,
          body: `**Original Pull Request:** ${pr.html_url}\n\n**State:** ${pr.state}\n**Merged:** ${pr.merged_at ? 'Yes' : 'No'}\n\n---\n\n${pr.body || 'No description provided'}`,
          labels: pullRequestLabelId ? [pullRequestLabelId] : [],
          closed: pr.state === "closed" || pr.merged_at !== null,
        };
        
        try {
          await httpPost(
            `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues`,
            basicIssueData,
            {
              Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
            }
          );
          successCount++;
          console.log(`[Pull Requests] ✅ Created basic issue for PR #${pr.number}`);
        } catch (error) {
          failedCount++;
          console.error(
            `[Pull Requests] ❌ Failed to mirror PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    },
    {
      concurrencyLimit: pullRequestConcurrencyLimit,
      maxRetries: 3,
      retryDelay: 1000,
    }
  );

  console.log(`✅ Mirrored ${successCount}/${filteredPRs.length} pull requests to Gitea as enriched issues (${failedCount} failed${isIncrementalSync && skippedCount > 0 ? `, ${skippedCount} already existed` : ''})`);
}

export async function mirrorGitRepoLabelsToGitea({
  config,
  octokit,
  repository,
  giteaOwner,
  giteaRepoName,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
  giteaRepoName?: string;
}) {
  if (
    !config.githubConfig?.token ||
    !config.giteaConfig?.token ||
    !config.giteaConfig?.url
  ) {
    throw new Error("Missing GitHub or Gitea configuration.");
  }

  // Decrypt config tokens for API usage
  const decryptedConfig = decryptConfigTokens(config as Config);
  
  // Use provided giteaRepoName or fall back to repository.name
  const repoName = giteaRepoName || repository.name;
  
  // Verify the repository exists in Gitea before attempting to mirror metadata
  console.log(`[Labels] Verifying repository ${repoName} exists at ${giteaOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: giteaOwner,
    repoName: repoName,
  });
  
  if (!repoExists) {
    console.error(`[Labels] Repository ${repoName} not found at ${giteaOwner}. Cannot mirror labels.`);
    throw new Error(`Repository ${repoName} does not exist in Gitea at ${giteaOwner}. Please ensure the repository is mirrored first.`);
  }

  const [owner, repo] = repository.fullName.split("/");

  // Fetch GitHub labels
  const labels = await octokit.paginate(
    octokit.rest.issues.listLabelsForRepo,
    {
      owner,
      repo,
      per_page: 100,
    },
    (res) => res.data
  );

  console.log(`Mirroring ${labels.length} labels from ${repository.fullName}`);

  if (labels.length === 0) {
    console.log(`No labels to mirror for ${repository.fullName}`);
    return;
  }

  // Get existing labels from Gitea
  const giteaLabelsRes = await httpGet(
    `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/labels`,
    {
      Authorization: `token ${decryptedConfig.giteaConfig.token}`,
    }
  );

  const existingLabels = new Set(
    giteaLabelsRes.data.map((label: any) => label.name)
  );

  let mirroredCount = 0;
  for (const label of labels) {
    if (!existingLabels.has(label.name)) {
      try {
        await httpPost(
          `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/labels`,
          {
            name: label.name,
            color: `#${label.color}`,
            description: label.description || "",
          },
          {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
          }
        );
        mirroredCount++;
      } catch (error) {
        console.error(
          `Failed to mirror label "${label.name}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  console.log(`✅ Mirrored ${mirroredCount} new labels to Gitea`);
}

export async function mirrorGitRepoMilestonesToGitea({
  config,
  octokit,
  repository,
  giteaOwner,
  giteaRepoName,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
  giteaRepoName?: string;
}) {
  if (
    !config.githubConfig?.token ||
    !config.giteaConfig?.token ||
    !config.giteaConfig?.url
  ) {
    throw new Error("Missing GitHub or Gitea configuration.");
  }

  // Decrypt config tokens for API usage
  const decryptedConfig = decryptConfigTokens(config as Config);
  
  // Use provided giteaRepoName or fall back to repository.name
  const repoName = giteaRepoName || repository.name;
  
  // Verify the repository exists in Gitea before attempting to mirror metadata
  console.log(`[Milestones] Verifying repository ${repoName} exists at ${giteaOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: giteaOwner,
    repoName: repoName,
  });
  
  if (!repoExists) {
    console.error(`[Milestones] Repository ${repoName} not found at ${giteaOwner}. Cannot mirror milestones.`);
    throw new Error(`Repository ${repoName} does not exist in Gitea at ${giteaOwner}. Please ensure the repository is mirrored first.`);
  }

  const [owner, repo] = repository.fullName.split("/");

  // Fetch GitHub milestones
  const milestones = await octokit.paginate(
    octokit.rest.issues.listMilestones,
    {
      owner,
      repo,
      state: "all",
      per_page: 100,
    },
    (res) => res.data
  );

  console.log(`Mirroring ${milestones.length} milestones from ${repository.fullName}`);

  if (milestones.length === 0) {
    console.log(`No milestones to mirror for ${repository.fullName}`);
    return;
  }

  // Get existing milestones from Gitea
  const giteaMilestonesRes = await httpGet(
    `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/milestones`,
    {
      Authorization: `token ${decryptedConfig.giteaConfig.token}`,
    }
  );

  const existingMilestones = new Set(
    giteaMilestonesRes.data.map((milestone: any) => milestone.title)
  );

  let mirroredCount = 0;
  for (const milestone of milestones) {
    if (!existingMilestones.has(milestone.title)) {
      try {
        await httpPost(
          `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/milestones`,
          {
            title: milestone.title,
            description: milestone.description || "",
            due_on: milestone.due_on,
            state: milestone.state,
          },
          {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
          }
        );
        mirroredCount++;
      } catch (error) {
        console.error(
          `Failed to mirror milestone "${milestone.title}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  console.log(`✅ Mirrored ${mirroredCount} new milestones to Gitea`);
}

/**
 * Create a simple Gitea client object with base URL and token
 */
export function createGiteaClient(url: string, token: string) {
  return { url, token };
}

/**
 * Delete a repository from Gitea
 */
export async function deleteGiteaRepo(
  client: { url: string; token: string },
  owner: string,
  repo: string
): Promise<void> {
  try {
    const response = await httpDelete(
      `${client.url}/api/v1/repos/${owner}/${repo}`,
      {
        Authorization: `token ${client.token}`,
      }
    );
    
    if (response.status >= 400) {
      throw new Error(`Failed to delete repository ${owner}/${repo}: ${response.status} ${response.statusText}`);
    }
    
    console.log(`Successfully deleted repository ${owner}/${repo} from Gitea`);
  } catch (error) {
    console.error(`Error deleting repository ${owner}/${repo}:`, error);
    throw error;
  }
}

/**
 * Archive a repository in Gitea
 * 
 * IMPORTANT: This function NEVER deletes data. It only marks repositories as archived.
 * - For regular repos: Uses Gitea's archive feature (makes read-only)
 * - For mirror repos: Renames with [ARCHIVED] prefix (Gitea doesn't allow archiving mirrors)
 * 
 * This ensures backups are preserved even when the GitHub source disappears.
 */
export async function archiveGiteaRepo(
  client: { url: string; token: string },
  owner: string,
  repo: string
): Promise<void> {
  try {
    // Helper: sanitize to Gitea's AlphaDashDot rule
    const sanitizeRepoNameAlphaDashDot = (name: string): string => {
      // Replace anything that's not [A-Za-z0-9.-] with '-'
      const base = name.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/-+/g, "-");
      // Trim leading/trailing separators and dots for safety
      return base.replace(/^[.-]+/, "").replace(/[.-]+$/, "");
    };

    // First, check if this is a mirror repository
    const repoResponse = await httpGet(
      `${client.url}/api/v1/repos/${owner}/${repo}`,
      {
        Authorization: `token ${client.token}`,
      }
    );
    
    if (!repoResponse.data) {
      console.warn(`[Archive] Repository ${owner}/${repo} not found in Gitea. Skipping.`);
      return;
    }
    
    if (repoResponse.data?.mirror) {
      console.log(`[Archive] Repository ${owner}/${repo} is a mirror. Using safe rename strategy.`);
      
      // IMPORTANT: Gitea API doesn't allow archiving mirror repositories
      // According to Gitea source code, attempting to archive a mirror returns:
      // "repo is a mirror, cannot archive/un-archive" (422 Unprocessable Entity)
      // 
      // Our solution: Rename the repo to clearly mark it as orphaned
      // This preserves all data while indicating the repo is no longer actively synced
      
      const currentName = repoResponse.data.name;
      
      // Skip if already marked as archived
      const normalizedName = currentName.toLowerCase();
      if (
        currentName.startsWith('[ARCHIVED]') ||
        normalizedName.startsWith('archived-')
      ) {
        console.log(`[Archive] Repository ${owner}/${repo} already marked as archived. Skipping.`);
        return;
      }
      
      // Use a safe prefix and sanitize the name to satisfy AlphaDashDot rule
      let archivedName = `archived-${sanitizeRepoNameAlphaDashDot(currentName)}`;
      const currentDesc = repoResponse.data.description || '';
      const archiveNotice = `\n\n⚠️ ARCHIVED: Original GitHub repository no longer exists. Preserved as backup on ${new Date().toISOString()}`;
      
      // Only add notice if not already present
      const newDescription = currentDesc.includes('⚠️ ARCHIVED:') 
        ? currentDesc 
        : currentDesc + archiveNotice;
      
      try {
        await httpPatch(
          `${client.url}/api/v1/repos/${owner}/${repo}`,
          {
            name: archivedName,
            description: newDescription,
          },
          {
            Authorization: `token ${client.token}`,
            'Content-Type': 'application/json',
          }
        );
      } catch (e: any) {
        // If rename fails (e.g., 422 AlphaDashDot or name conflict), attempt a timestamped fallback
        const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
        archivedName = `archived-${ts}-${sanitizeRepoNameAlphaDashDot(currentName)}`;
        try {
          await httpPatch(
            `${client.url}/api/v1/repos/${owner}/${repo}`,
            {
              name: archivedName,
              description: newDescription,
            },
            {
              Authorization: `token ${client.token}`,
              'Content-Type': 'application/json',
            }
          );
        } catch (e2) {
          // If this also fails, log but don't throw - data remains preserved
          console.error(`[Archive] Failed to rename mirror repository ${owner}/${repo}:`, e2);
          console.log(`[Archive] Repository ${owner}/${repo} remains accessible but not marked as archived`);
          return;
        }
      }
      
      console.log(`[Archive] Successfully marked mirror repository ${owner}/${repo} as archived (renamed to ${archivedName})`);
      
      // Also try to reduce sync frequency to prevent unnecessary API calls
      // This is optional - if it fails, the repo is still preserved
      try {
        await httpPatch(
          `${client.url}/api/v1/repos/${owner}/${archivedName}`,
          {
            mirror_interval: "0h", // Disable automatic syncing; manual sync is still available
          },
          {
            Authorization: `token ${client.token}`,
            'Content-Type': 'application/json',
          }
        );
        console.log(`[Archive] Disabled automatic syncs for ${owner}/${archivedName}; manual sync only`);
      } catch (intervalError) {
        // Non-critical - repo is still preserved even if we can't change interval
        console.debug(`[Archive] Could not disable mirror interval (non-critical):`, intervalError);
      }
    } else {
      // For non-mirror repositories, use Gitea's native archive feature
      // This makes the repository read-only but preserves all data
      console.log(`[Archive] Archiving regular repository ${owner}/${repo}`);
      
      const response = await httpPatch(
        `${client.url}/api/v1/repos/${owner}/${repo}`,
        {
          archived: true,
        },
        {
          Authorization: `token ${client.token}`,
          'Content-Type': 'application/json',
        }
      );
      
      if (response.status >= 400) {
        // If archive fails, log but data is still preserved in Gitea
        console.error(`[Archive] Failed to archive repository ${owner}/${repo}: ${response.status}`);
        console.log(`[Archive] Repository ${owner}/${repo} remains accessible but not marked as archived`);
        return;
      }
      
      console.log(`[Archive] Successfully archived repository ${owner}/${repo} (now read-only)`);
    }
  } catch (error) {
    // Even on error, the repository data is preserved in Gitea
    // We just couldn't mark it as archived
    console.error(`[Archive] Could not mark repository ${owner}/${repo} as archived:`, error);
    console.log(`[Archive] Repository ${owner}/${repo} data is preserved but not marked as archived`);
    // Don't throw - we want cleanup to continue for other repos
  }
}
