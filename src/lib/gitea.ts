import {
  repoStatusEnum,
  type RepositoryVisibility,
  type RepoStatus,
} from "@/types/Repository";
import { membershipRoleEnum } from "@/types/organizations";
import { Octokit } from "@octokit/rest";
import type { Config } from "@/types/config";
import type { Organization, Repository } from "./db/schema";
import { httpPost, httpGet } from "./http-client";
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
    const repoOwner = await getGiteaRepoOwnerAsync({ config, repository });

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
      await getOrCreateGiteaOrg({
        orgName: repoOwner,
        config,
      });
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
        wiki: config.githubConfig.mirrorWiki || false, // will mirror wiki if it exists
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
    if (config.githubConfig?.mirrorReleases) {
      await mirrorGitHubReleasesToGitea({
        config,
        octokit,
        repository,
      });
    }

    // clone issues
    // Skip issues for starred repos if skipStarredIssues is enabled
    const shouldMirrorIssues = config.githubConfig.mirrorIssues && 
      !(repository.isStarred && config.githubConfig.skipStarredIssues);
    
    if (shouldMirrorIssues) {
      await mirrorGitRepoIssuesToGitea({
        config,
        octokit,
        repository,
        giteaOwner: repoOwner,
      });
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
        wiki: config.githubConfig?.mirrorWiki || false, // will mirror wiki if it exists
        private: repository.isPrivate,
      },
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    //mirror releases
    if (config.githubConfig?.mirrorReleases) {
      await mirrorGitHubReleasesToGitea({
        config,
        octokit,
        repository,
      });
    }

    // Clone issues
    // Skip issues for starred repos if skipStarredIssues is enabled
    const shouldMirrorIssues = config.githubConfig?.mirrorIssues && 
      !(repository.isStarred && config.githubConfig?.skipStarredIssues);
    
    if (shouldMirrorIssues) {
      await mirrorGitRepoIssuesToGitea({
        config,
        octokit,
        repository,
        giteaOwner: orgName,
      });
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
    !config.giteaConfig?.username
  ) {
    throw new Error("Missing GitHub or Gitea configuration.");
  }

  // Decrypt config tokens for API usage
  const decryptedConfig = decryptConfigTokens(config as Config);

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
                Authorization: `token ${config.giteaConfig!.token}`,
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
          Authorization: `token ${config.giteaConfig!.token}`,
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
                Authorization: `token ${config.giteaConfig!.token}`,
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

  const repoOwner = await getGiteaRepoOwnerAsync({
    config,
    repository,
  });

  const { url, token } = config.giteaConfig;

  const releases = await octokit.rest.repos.listReleases({
    owner: repository.owner,
    repo: repository.name,
  });

  for (const release of releases.data) {
    await httpPost(
      `${url}/api/v1/repos/${repoOwner}/${repository.name}/releases`,
      {
        tag_name: release.tag_name,
        target: release.target_commitish,
        title: release.name || release.tag_name,
        note: release.body || "",
        draft: release.draft,
        prerelease: release.prerelease,
      },
      {
        Authorization: `token ${token}`,
      }
    );
  }

  console.log(`✅ Mirrored ${releases.data.length} GitHub releases to Gitea`);
}