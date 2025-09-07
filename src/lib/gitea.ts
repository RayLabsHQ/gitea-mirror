import {
  repoStatusEnum,
  type RepositoryVisibility,
  type RepoStatus,
} from "@/types/Repository";
import { membershipRoleEnum } from "@/types/organizations";
import { Octokit } from "@octokit/rest";
import type { Config } from "@/types/config";
import type { Organization, Repository } from "./db/schema";
import { httpPost, httpGet, httpDelete, httpPut } from "./http-client";
import { createMirrorJob } from "./helpers";
import { db, organizations, repositories } from "./db";
import { eq, and } from "drizzle-orm";
import { decryptConfigTokens } from "./utils/config-encryption";

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

    const isExisting = await isRepoPresentInGitea({
      config,
      owner: repoOwner,
      repoName: repository.name,
    });

    if (isExisting) {
      console.log(
        `Repository ${repository.name} already exists in Gitea under ${repoOwner}. Updating database status.`
      );

      // Update database to reflect that the repository is already mirrored
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("mirrored"),
          updatedAt: new Date(),
          lastMirrored: new Date(),
          errorMessage: null,
          mirroredLocation: `${repoOwner}/${repository.name}`,
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

    // Mark repos as "mirroring" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirroring"),
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

    let cloneAddress = repository.cloneUrl;

    // If the repository is private, inject the GitHub token into the clone URL
    if (repository.isPrivate) {
      if (!config.githubConfig.token) {
        throw new Error(
          "GitHub token is required to mirror private repositories."
        );
      }

      cloneAddress = repository.cloneUrl.replace(
        "https://",
        `https://${decryptedConfig.githubConfig.token}@`
      );
    }

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
      repoName: repository.name,
    });

    if (existingRepo && !existingRepo.mirror) {
      console.log(`Repository ${repository.name} exists but is not a mirror. Handling...`);
      
      // Handle the existing non-mirror repository
      await handleExistingNonMirrorRepo({
        config,
        repository,
        repoInfo: existingRepo,
        strategy: "delete", // Can be configured: "skip", "delete", or "rename"
      });
      
      // After handling, proceed with mirror creation
      console.log(`Proceeding with mirror creation for ${repository.name}`);
    }

    const response = await httpPost(
      apiUrl,
      {
        clone_addr: cloneAddress,
        repo_name: repository.name,
        mirror: true,
        mirror_interval: config.giteaConfig?.mirrorInterval || "8h", // Set mirror interval
        wiki: config.giteaConfig?.wiki || false, // will mirror wiki if it exists
        lfs: config.giteaConfig?.lfs || false, // Enable LFS mirroring if configured
        private: repository.isPrivate,
        repo_owner: repoOwner,
        description: "",
        service: "git",
      },
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    //mirror releases
    console.log(`[Metadata] Release mirroring check: mirrorReleases=${config.giteaConfig?.mirrorReleases}`);
    if (config.giteaConfig?.mirrorReleases) {
      try {
        await mirrorGitHubReleasesToGitea({
          config,
          octokit,
          repository,
        });
        console.log(`[Metadata] Successfully mirrored releases for ${repository.name}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror releases for ${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other operations even if releases fail
      }
    }

    // clone issues
    // Skip issues for starred repos if skipStarredIssues is enabled
    const shouldMirrorIssues = config.giteaConfig?.mirrorIssues && 
      !(repository.isStarred && config.githubConfig?.skipStarredIssues);
    
    console.log(`[Metadata] Issue mirroring check: mirrorIssues=${config.giteaConfig?.mirrorIssues}, isStarred=${repository.isStarred}, skipStarredIssues=${config.githubConfig?.skipStarredIssues}, shouldMirrorIssues=${shouldMirrorIssues}`);
    
    if (shouldMirrorIssues) {
      try {
        await mirrorGitRepoIssuesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
        });
        console.log(`[Metadata] Successfully mirrored issues for ${repository.name}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror issues for ${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other metadata operations even if issues fail
      }
    }

    // Mirror pull requests if enabled
    console.log(`[Metadata] Pull request mirroring check: mirrorPullRequests=${config.giteaConfig?.mirrorPullRequests}`);
    if (config.giteaConfig?.mirrorPullRequests) {
      try {
        await mirrorGitRepoPullRequestsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
        });
        console.log(`[Metadata] Successfully mirrored pull requests for ${repository.name}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror pull requests for ${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other metadata operations even if PRs fail
      }
    }

    // Mirror labels if enabled (and not already done via issues)
    console.log(`[Metadata] Label mirroring check: mirrorLabels=${config.giteaConfig?.mirrorLabels}, shouldMirrorIssues=${shouldMirrorIssues}`);
    if (config.giteaConfig?.mirrorLabels && !shouldMirrorIssues) {
      try {
        await mirrorGitRepoLabelsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
        });
        console.log(`[Metadata] Successfully mirrored labels for ${repository.name}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror labels for ${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other metadata operations even if labels fail
      }
    }

    // Mirror milestones if enabled
    console.log(`[Metadata] Milestone mirroring check: mirrorMilestones=${config.giteaConfig?.mirrorMilestones}`);
    if (config.giteaConfig?.mirrorMilestones) {
      try {
        await mirrorGitRepoMilestonesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
        });
        console.log(`[Metadata] Successfully mirrored milestones for ${repository.name}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror milestones for ${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other metadata operations even if milestones fail
      }
    }

    console.log(`Repository ${repository.name} mirrored successfully`);

    // Mark repos as "mirrored" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: `${repoOwner}/${repository.name}`,
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "mirrored" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Successfully mirrored repository: ${repository.name}`,
      details: `Repository ${repository.name} was mirrored to Gitea.`,
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

    const isExisting = await isRepoPresentInGitea({
      config,
      owner: orgName,
      repoName: repository.name,
    });

    if (isExisting) {
      console.log(
        `Repository ${repository.name} already exists in Gitea organization ${orgName}. Updating database status.`
      );

      // Update database to reflect that the repository is already mirrored
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("mirrored"),
          updatedAt: new Date(),
          lastMirrored: new Date(),
          errorMessage: null,
          mirroredLocation: `${orgName}/${repository.name}`,
        })
        .where(eq(repositories.id, repository.id!));

      // Create a mirror job log entry
      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Repository ${repository.name} already exists in Gitea organization ${orgName}`,
        details: `Repository ${repository.name} was found to already exist in Gitea organization ${orgName} and database status was updated.`,
        status: "mirrored",
      });

      console.log(
        `Repository ${repository.name} database status updated to mirrored in organization ${orgName}`
      );
      return;
    }

    console.log(
      `Mirroring repository ${repository.name} to organization ${orgName}`
    );

    let cloneAddress = repository.cloneUrl;

    if (repository.isPrivate) {
      if (!config.githubConfig?.token) {
        throw new Error(
          "GitHub token is required to mirror private repositories."
        );
      }

      cloneAddress = repository.cloneUrl.replace(
        "https://",
        `https://${decryptedConfig.githubConfig.token}@`
      );
    }

    // Mark repos as "mirroring" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirroring"),
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id!));

    // Note: "mirroring" status events are handled by the concurrency system
    // to avoid duplicate events during batch operations

    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/migrate`;

    const migrateRes = await httpPost(
      apiUrl,
      {
        clone_addr: cloneAddress,
        uid: giteaOrgId,
        repo_name: repository.name,
        mirror: true,
        mirror_interval: config.giteaConfig?.mirrorInterval || "8h", // Set mirror interval
        wiki: config.giteaConfig?.wiki || false, // will mirror wiki if it exists
        lfs: config.giteaConfig?.lfs || false, // Enable LFS mirroring if configured
        private: repository.isPrivate,
      },
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    //mirror releases
    console.log(`[Metadata] Release mirroring check: mirrorReleases=${config.giteaConfig?.mirrorReleases}`);
    if (config.giteaConfig?.mirrorReleases) {
      try {
        await mirrorGitHubReleasesToGitea({
          config,
          octokit,
          repository,
        });
        console.log(`[Metadata] Successfully mirrored releases for ${repository.name}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror releases for ${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other operations even if releases fail
      }
    }

    // Clone issues
    // Skip issues for starred repos if skipStarredIssues is enabled
    const shouldMirrorIssues = config.giteaConfig?.mirrorIssues && 
      !(repository.isStarred && config.githubConfig?.skipStarredIssues);
    
    console.log(`[Metadata] Issue mirroring check: mirrorIssues=${config.giteaConfig?.mirrorIssues}, isStarred=${repository.isStarred}, skipStarredIssues=${config.githubConfig?.skipStarredIssues}, shouldMirrorIssues=${shouldMirrorIssues}`);
    
    if (shouldMirrorIssues) {
      try {
        await mirrorGitRepoIssuesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
        });
        console.log(`[Metadata] Successfully mirrored issues for ${repository.name} to org ${orgName}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror issues for ${repository.name} to org ${orgName}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other metadata operations even if issues fail
      }
    }

    // Mirror pull requests if enabled
    console.log(`[Metadata] Pull request mirroring check: mirrorPullRequests=${config.giteaConfig?.mirrorPullRequests}`);
    if (config.giteaConfig?.mirrorPullRequests) {
      try {
        await mirrorGitRepoPullRequestsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
        });
        console.log(`[Metadata] Successfully mirrored pull requests for ${repository.name} to org ${orgName}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror pull requests for ${repository.name} to org ${orgName}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other metadata operations even if PRs fail
      }
    }

    // Mirror labels if enabled (and not already done via issues)
    console.log(`[Metadata] Label mirroring check: mirrorLabels=${config.giteaConfig?.mirrorLabels}, shouldMirrorIssues=${shouldMirrorIssues}`);
    if (config.giteaConfig?.mirrorLabels && !shouldMirrorIssues) {
      try {
        await mirrorGitRepoLabelsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
        });
        console.log(`[Metadata] Successfully mirrored labels for ${repository.name} to org ${orgName}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror labels for ${repository.name} to org ${orgName}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other metadata operations even if labels fail
      }
    }

    // Mirror milestones if enabled
    console.log(`[Metadata] Milestone mirroring check: mirrorMilestones=${config.giteaConfig?.mirrorMilestones}`);
    if (config.giteaConfig?.mirrorMilestones) {
      try {
        await mirrorGitRepoMilestonesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
        });
        console.log(`[Metadata] Successfully mirrored milestones for ${repository.name} to org ${orgName}`);
      } catch (error) {
        console.error(`[Metadata] Failed to mirror milestones for ${repository.name} to org ${orgName}: ${error instanceof Error ? error.message : String(error)}`);
        // Continue with other metadata operations even if milestones fail
      }
    }

    console.log(
      `Repository ${repository.name} mirrored successfully to organization ${orgName}`
    );

    // Mark repos as "mirrored" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: `${orgName}/${repository.name}`,
      })
      .where(eq(repositories.id, repository.id!));

    //create a mirror job
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Repository ${repository.name} mirrored successfully`,
      details: `Repository ${repository.name} was mirrored to Gitea`,
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
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
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
  
  // Log configuration details for debugging
  console.log(`[Issues] Starting issue mirroring for repository ${repository.name}`);
  console.log(`[Issues] Gitea URL: ${config.giteaConfig!.url}`);
  console.log(`[Issues] Gitea Owner: ${giteaOwner}`);
  console.log(`[Issues] Gitea Default Owner: ${config.giteaConfig!.defaultOwner}`);
  
  // Verify the repository exists in Gitea before attempting to mirror metadata
  console.log(`[Issues] Verifying repository ${repository.name} exists at ${giteaOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: giteaOwner,
    repoName: repository.name,
  });
  
  if (!repoExists) {
    console.error(`[Issues] Repository ${repository.name} not found at ${giteaOwner}. Cannot mirror issues.`);
    throw new Error(`Repository ${repository.name} does not exist in Gitea at ${giteaOwner}. Please ensure the repository is mirrored first.`);
  }

  const [owner, repo] = repository.fullName.split("/");

  // Fetch GitHub issues
  const issues = await octokit.paginate(
    octokit.rest.issues.listForRepo,
    {
      owner,
      repo,
      state: "all",
      per_page: 100,
    },
    (res) => res.data
  );

  // Filter out pull requests
  const filteredIssues = issues.filter((issue) => !(issue as any).pull_request);

  console.log(
    `Mirroring ${filteredIssues.length} issues from ${repository.fullName}`
  );

  if (filteredIssues.length === 0) {
    console.log(`No issues to mirror for ${repository.fullName}`);
    return;
  }

  // Get existing labels from Gitea
  const giteaLabelsRes = await httpGet(
    `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repository.name}/labels`,
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

  // Process issues in parallel with concurrency control
  await processWithRetry(
    filteredIssues,
    async (issue) => {
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
              `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${
                repository.name
              }/labels`,
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

      const issuePayload: any = {
        title: issue.title,
        body: `Originally created by @${
          issue.user?.login
        } on GitHub.${originalAssignees}\n\n${issue.body || ""}`,
        closed: issue.state === "closed",
        labels: giteaLabelIds,
      };

      // Create the issue in Gitea
      const createdIssue = await httpPost(
        `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${
          repository.name
        }/issues`,
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

      // Process comments in parallel with concurrency control
      if (comments.length > 0) {
        await processWithRetry(
          comments,
          async (comment) => {
            await httpPost(
              `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${
                repository.name
              }/issues/${createdIssue.data.number}/comments`,
              {
                body: `@${comment.user?.login} commented on GitHub:\n\n${comment.body}`,
              },
              {
                Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
              }
            );
            return comment;
          },
          {
            concurrencyLimit: 5,
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
      concurrencyLimit: 3, // Process 3 issues at a time
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

  console.log(
    `Completed mirroring ${filteredIssues.length} issues for ${repository.fullName}`
  );
};

export async function mirrorGitHubReleasesToGitea({
  octokit,
  repository,
  config,
}: {
  octokit: Octokit;
  repository: Repository;
  config: Partial<Config>;
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

  const repoOwner = await getGiteaRepoOwnerAsync({
    config,
    repository,
  });

  // Verify the repository exists in Gitea before attempting to mirror releases
  console.log(`[Releases] Verifying repository ${repository.name} exists at ${repoOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: repoOwner,
    repoName: repository.name,
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

  // Sort releases by created_at to ensure we get the most recent ones
  const sortedReleases = releases.data.sort((a, b) => 
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  ).slice(0, releaseLimit);

  for (const release of sortedReleases) {
    try {
      // Check if release already exists
      const existingReleasesResponse = await httpGet(
        `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repository.name}/releases/tags/${release.tag_name}`,
        {
          Authorization: `token ${decryptedConfig.giteaConfig.token}`,
        }
      ).catch(() => null);

      const releaseNote = release.body || "";
      
      if (existingReleasesResponse) {
        // Update existing release if the changelog/body differs
        const existingRelease = existingReleasesResponse.data;
        const existingNote = existingRelease.body || "";
        
        if (existingNote !== releaseNote || existingRelease.name !== (release.name || release.tag_name)) {
          console.log(`[Releases] Updating existing release ${release.tag_name} with new changelog/title`);
          
          await httpPut(
            `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repository.name}/releases/${existingRelease.id}`,
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
          
          if (releaseNote) {
            console.log(`[Releases] Updated changelog for ${release.tag_name} (${releaseNote.length} characters)`);
          }
          mirroredCount++;
        } else {
          console.log(`[Releases] Release ${release.tag_name} already up-to-date, skipping`);
          skippedCount++;
        }
        continue;
      }

      // Create new release with changelog/body content
      if (releaseNote) {
        console.log(`[Releases] Including changelog for ${release.tag_name} (${releaseNote.length} characters)`);
      }
      
      const createReleaseResponse = await httpPost(
        `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repository.name}/releases`,
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
              `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repository.name}/releases/${createReleaseResponse.data.id}/assets?name=${encodeURIComponent(asset.name)}`,
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
      const noteInfo = releaseNote ? ` with ${releaseNote.length} character changelog` : " without changelog";
      console.log(`[Releases] Successfully mirrored release: ${release.tag_name}${noteInfo}`);
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
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
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
  
  // Log configuration details for debugging
  console.log(`[Pull Requests] Starting PR mirroring for repository ${repository.name}`);
  console.log(`[Pull Requests] Gitea URL: ${config.giteaConfig!.url}`);
  console.log(`[Pull Requests] Gitea Owner: ${giteaOwner}`);
  console.log(`[Pull Requests] Gitea Default Owner: ${config.giteaConfig!.defaultOwner}`);
  
  // Verify the repository exists in Gitea before attempting to mirror metadata
  console.log(`[Pull Requests] Verifying repository ${repository.name} exists at ${giteaOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: giteaOwner,
    repoName: repository.name,
  });
  
  if (!repoExists) {
    console.error(`[Pull Requests] Repository ${repository.name} not found at ${giteaOwner}. Cannot mirror PRs.`);
    throw new Error(`Repository ${repository.name} does not exist in Gitea at ${giteaOwner}. Please ensure the repository is mirrored first.`);
  }

  const [owner, repo] = repository.fullName.split("/");

  // Fetch GitHub pull requests
  const pullRequests = await octokit.paginate(
    octokit.rest.pulls.list,
    {
      owner,
      repo,
      state: "all",
      per_page: 100,
    },
    (res) => res.data
  );

  console.log(
    `Mirroring ${pullRequests.length} pull requests from ${repository.fullName}`
  );

  if (pullRequests.length === 0) {
    console.log(`No pull requests to mirror for ${repository.fullName}`);
    return;
  }

  // Note: Gitea doesn't have a direct API to create pull requests from external sources
  // Pull requests are typically created through Git operations
  // For now, we'll create them as issues with a special label
  
  // Get existing labels from Gitea and ensure "pull-request" label exists
  const giteaLabelsRes = await httpGet(
    `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repository.name}/labels`,
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
        `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repository.name}/labels`,
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

  let successCount = 0;
  let failedCount = 0;

  await processWithRetry(
    pullRequests,
    async (pr) => {
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
          `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repository.name}/issues`,
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
            `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repository.name}/issues`,
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
      concurrencyLimit: 5,
      maxRetries: 3,
      retryDelay: 1000,
    }
  );

  console.log(`✅ Mirrored ${successCount}/${pullRequests.length} pull requests to Gitea as enriched issues (${failedCount} failed)`);
}

export async function mirrorGitRepoLabelsToGitea({
  config,
  octokit,
  repository,
  giteaOwner,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
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
  
  // Verify the repository exists in Gitea before attempting to mirror metadata
  console.log(`[Labels] Verifying repository ${repository.name} exists at ${giteaOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: giteaOwner,
    repoName: repository.name,
  });
  
  if (!repoExists) {
    console.error(`[Labels] Repository ${repository.name} not found at ${giteaOwner}. Cannot mirror labels.`);
    throw new Error(`Repository ${repository.name} does not exist in Gitea at ${giteaOwner}. Please ensure the repository is mirrored first.`);
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
    `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repository.name}/labels`,
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
          `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repository.name}/labels`,
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
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
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
  
  // Verify the repository exists in Gitea before attempting to mirror metadata
  console.log(`[Milestones] Verifying repository ${repository.name} exists at ${giteaOwner}`);
  const repoExists = await isRepoPresentInGitea({
    config,
    owner: giteaOwner,
    repoName: repository.name,
  });
  
  if (!repoExists) {
    console.error(`[Milestones] Repository ${repository.name} not found at ${giteaOwner}. Cannot mirror milestones.`);
    throw new Error(`Repository ${repository.name} does not exist in Gitea at ${giteaOwner}. Please ensure the repository is mirrored first.`);
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
    `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repository.name}/milestones`,
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
          `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repository.name}/milestones`,
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
 */
export async function archiveGiteaRepo(
  client: { url: string; token: string },
  owner: string,
  repo: string
): Promise<void> {
  try {
    const response = await httpPut(
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
      throw new Error(`Failed to archive repository ${owner}/${repo}: ${response.status} ${response.statusText}`);
    }
    
    console.log(`Successfully archived repository ${owner}/${repo} in Gitea`);
  } catch (error) {
    console.error(`Error archiving repository ${owner}/${repo}:`, error);
    throw error;
  }
}
