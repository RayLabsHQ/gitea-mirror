import {
  repoStatusEnum,
  type RepositoryVisibility,
  type RepoStatus,
} from "@/types/Repository";
import { Octokit } from "@octokit/rest";
import type { Config } from "@/types/config";
import type { Organization, Repository } from "./db/schema";
import { httpPost, httpGet } from "./http-client";
import { createMirrorJob } from "./helpers";
import { db, organizations, repositories } from "./db";
import { eq } from "drizzle-orm";

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

  if (!config.giteaConfig.username) {
    throw new Error("Gitea username is required.");
  }

  // if the config has preserveOrgStructure set to true, then use the org name as the owner
  if (config.githubConfig.preserveOrgStructure && repository.organization) {
    return repository.organization;
  }

  // if the config has preserveOrgStructure set to false, then use the gitea username as the owner
  return config.giteaConfig.username;
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

    // Check if the repository exists at the specified owner location
    const response = await fetch(
      `${config.giteaConfig.url}/api/v1/repos/${owner}/${repoName}`,
      {
        headers: {
          Authorization: `token ${config.giteaConfig.token}`,
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

    if (!config.giteaConfig.username) {
      throw new Error("Gitea username is required.");
    }

    const isExisting = await isRepoPresentInGitea({
      config,
      owner: config.giteaConfig.username,
      repoName: repository.name,
    });

    if (isExisting) {
      console.log(
        `Repository ${repository.name} already exists in Gitea. Updating database status.`
      );

      // Update database to reflect that the repository is already mirrored
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("mirrored"),
          updatedAt: new Date(),
          lastMirrored: new Date(),
          errorMessage: null,
          mirroredLocation: `${config.giteaConfig.username}/${repository.name}`,
        })
        .where(eq(repositories.id, repository.id!));

      // Append log for "mirrored" status
      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Repository ${repository.name} already exists in Gitea`,
        details: `Repository ${repository.name} was found to already exist in Gitea and database status was updated.`,
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
        `https://${config.githubConfig.token}@`
      );
    }

    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/migrate`;

    const response = await httpPost(
      apiUrl,
      {
        clone_addr: cloneAddress,
        repo_name: repository.name,
        mirror: true,
        wiki: true, // will mirror wiki if it exists
        private: repository.isPrivate,
        repo_owner: config.giteaConfig.username,
        description: "",
        service: "git",
      },
      {
        Authorization: `token ${config.giteaConfig.token}`,
      }
    );

    //mirror releases
    await mirrorGitHubReleasesToGitea({
      config,
      octokit,
      repository,
    });

    // clone issues
    if (config.githubConfig.mirrorIssues) {
      await mirrorGitRepoIssuesToGitea({
        config,
        octokit,
        repository,
        isRepoInOrg: false,
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
        mirroredLocation: `${config.giteaConfig.username}/${repository.name}`,
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
  if (
    !config.giteaConfig?.url ||
    !config.giteaConfig?.token ||
    !config.userId
  ) {
    throw new Error("Gitea config is required.");
  }

  try {
    console.log(`Attempting to get or create Gitea organization: ${orgName}`);

    const orgRes = await fetch(
      `${config.giteaConfig.url}/api/v1/orgs/${orgName}`,
      {
        headers: {
          Authorization: `token ${config.giteaConfig.token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(
      `Get org response status: ${orgRes.status} for org: ${orgName}`
    );

    if (orgRes.ok) {
      // Check if response is actually JSON
      const contentType = orgRes.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn(
          `Expected JSON response but got content-type: ${contentType}`
        );
        const responseText = await orgRes.text();
        console.warn(`Response body: ${responseText}`);
        throw new Error(
          `Invalid response format from Gitea API. Expected JSON but got: ${contentType}`
        );
      }

      // Clone the response to handle potential JSON parsing errors
      const orgResClone = orgRes.clone();

      try {
        const org = await orgRes.json();
        console.log(
          `Successfully retrieved existing org: ${orgName} with ID: ${org.id}`
        );
        // Note: Organization events are handled by the main mirroring process
        // to avoid duplicate events
        return org.id;
      } catch (jsonError) {
        const responseText = await orgResClone.text();
        console.error(
          `Failed to parse JSON response for existing org: ${responseText}`
        );
        throw new Error(
          `Failed to parse JSON response from Gitea API: ${
            jsonError instanceof Error ? jsonError.message : String(jsonError)
          }`
        );
      }
    }

    console.log(`Organization ${orgName} not found, attempting to create it`);

    const createRes = await fetch(`${config.giteaConfig.url}/api/v1/orgs`, {
      method: "POST",
      headers: {
        Authorization: `token ${config.giteaConfig.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: orgName,
        full_name: `${orgName} Org`,
        description: `Mirrored organization from GitHub ${orgName}`,
        visibility: "public",
      }),
    });

    console.log(
      `Create org response status: ${createRes.status} for org: ${orgName}`
    );

    if (!createRes.ok) {
      const errorText = await createRes.text();
      console.error(
        `Failed to create org ${orgName}. Status: ${createRes.status}, Response: ${errorText}`
      );
      throw new Error(`Failed to create Gitea org: ${errorText}`);
    }

    // Check if response is actually JSON
    const createContentType = createRes.headers.get("content-type");
    if (!createContentType || !createContentType.includes("application/json")) {
      console.warn(
        `Expected JSON response but got content-type: ${createContentType}`
      );
      const responseText = await createRes.text();
      console.warn(`Response body: ${responseText}`);
      throw new Error(
        `Invalid response format from Gitea API. Expected JSON but got: ${createContentType}`
      );
    }

    // Note: Organization creation events are handled by the main mirroring process
    // to avoid duplicate events

    // Clone the response to handle potential JSON parsing errors
    const createResClone = createRes.clone();

    try {
      const newOrg = await createRes.json();
      console.log(
        `Successfully created new org: ${orgName} with ID: ${newOrg.id}`
      );
      return newOrg.id;
    } catch (jsonError) {
      const responseText = await createResClone.text();
      console.error(
        `Failed to parse JSON response for new org: ${responseText}`
      );
      throw new Error(
        `Failed to parse JSON response from Gitea API: ${
          jsonError instanceof Error ? jsonError.message : String(jsonError)
        }`
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unknown error occurred in getOrCreateGiteaOrg.";

    console.error(
      `Error in getOrCreateGiteaOrg for ${orgName}: ${errorMessage}`
    );

    await createMirrorJob({
      userId: config.userId,
      organizationId: orgId,
      organizationName: orgName,
      message: `Failed to create or fetch Gitea organization: ${orgName}`,
      status: "failed",
      details: `Error: ${errorMessage}`,
    });

    throw new Error(`Error in getOrCreateGiteaOrg: ${errorMessage}`);
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
        `https://${config.githubConfig.token}@`
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
        wiki: true, // will mirror wiki if it exists
        private: repository.isPrivate,
      },
      {
        Authorization: `token ${config.giteaConfig.token}`,
      }
    );

    //mirror releases
    await mirrorGitHubReleasesToGitea({
      config,
      octokit,
      repository,
    });

    // Clone issues
    if (config.githubConfig?.mirrorIssues) {
      await mirrorGitRepoIssuesToGitea({
        config,
        octokit,
        repository,
        isRepoInOrg: true,
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

    const giteaOrgId = await getOrCreateGiteaOrg({
      orgId: organization.id,
      orgName: organization.name,
      config,
    });

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
            `Starting mirror for repository: ${repo.name} in organization ${organization.name}`
          );

          // Mirror the repository
          await mirrorGitHubRepoToGiteaOrg({
            octokit,
            config,
            repository: repoData,
            giteaOrgId,
            orgName: organization.name,
          });

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
  try {
    if (
      !config.userId ||
      !config.giteaConfig?.url ||
      !config.giteaConfig?.token ||
      !config.giteaConfig?.username
    ) {
      throw new Error("Gitea config is required.");
    }

    console.log(`Syncing repository ${repository.name}`);

    // Mark repo as "syncing" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("syncing"),
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "syncing" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Started syncing repository: ${repository.name}`,
      details: `Repository ${repository.name} is now in the syncing state.`,
      status: repoStatusEnum.parse("syncing"),
    });

    // Get the expected owner based on current config
    const repoOwner = getGiteaRepoOwner({ config, repository });

    // Check if repo exists at the expected location or alternate location
    const { present, actualOwner } = await checkRepoLocation({
      config,
      repository,
      expectedOwner: repoOwner,
    });

    if (!present) {
      throw new Error(
        `Repository ${repository.name} not found in Gitea at any expected location`
      );
    }

    // Use the actual owner where the repo was found
    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/${actualOwner}/${repository.name}/mirror-sync`;

    const response = await httpPost(apiUrl, undefined, {
      Authorization: `token ${config.giteaConfig.token}`,
    });

    // Mark repo as "synced" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("synced"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: `${actualOwner}/${repository.name}`,
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "synced" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Successfully synced repository: ${repository.name}`,
      details: `Repository ${repository.name} was synced with Gitea.`,
      status: repoStatusEnum.parse("synced"),
    });

    console.log(`Repository ${repository.name} synced successfully`);

    return response.data;
  } catch (error) {
    console.error(
      `Error while syncing repository ${repository.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    // Optional: update repo with error status
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: (error as Error).message,
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "error" status
    if (config.userId && repository.id && repository.name) {
      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Failed to sync repository: ${repository.name}`,
        details: (error as Error).message,
        status: repoStatusEnum.parse("failed"),
      });
    }

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
  isRepoInOrg,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  isRepoInOrg: boolean;
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

  const repoOrigin = isRepoInOrg
    ? repository.organization
    : config.githubConfig.username;

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
    `${config.giteaConfig.url}/api/v1/repos/${repoOrigin}/${repository.name}/labels`,
    {
      Authorization: `token ${config.giteaConfig.token}`,
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
              `${config.giteaConfig!.url}/api/v1/repos/${repoOrigin}/${
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
        `${config.giteaConfig!.url}/api/v1/repos/${repoOrigin}/${
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
              `${config.giteaConfig!.url}/api/v1/repos/${repoOrigin}/${
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
    !config.giteaConfig?.username ||
    !config.giteaConfig?.token ||
    !config.giteaConfig?.url
  ) {
    throw new Error("Gitea config is incomplete for mirroring releases.");
  }

  const repoOwner = getGiteaRepoOwner({
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
