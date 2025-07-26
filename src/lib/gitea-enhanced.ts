/**
 * Enhanced Gitea operations with better error handling for starred repositories
 * This module provides fixes for:
 * 1. "Repository is not a mirror" errors
 * 2. Duplicate organization constraint errors
 * 3. Race conditions in parallel processing
 */

import type { Config } from "@/types/config";
import type { Repository } from "./db/schema";
import { createMirrorJob } from "./helpers";
import { decryptConfigTokens } from "./utils/config-encryption";
import { httpPost, httpGet, HttpError } from "./http-client";
import { db, repositories } from "./db";
import { eq } from "drizzle-orm";
import { repoStatusEnum } from "@/types/Repository";

/**
 * Enhanced repository information including mirror status
 */
interface GiteaRepoInfo {
  id: number;
  name: string;
  owner: string;
  mirror: boolean;
  mirror_interval?: string;
  clone_url?: string;
  private: boolean;
}

/**
 * Check if a repository exists in Gitea and return its details
 */
export async function getGiteaRepoInfo({
  config,
  owner,
  repoName,
}: {
  config: Partial<Config>;
  owner: string;
  repoName: string;
}): Promise<GiteaRepoInfo | null> {
  try {
    if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
      throw new Error("Gitea config is required.");
    }

    const decryptedConfig = decryptConfigTokens(config as Config);
    
    const response = await httpGet<GiteaRepoInfo>(
      `${config.giteaConfig.url}/api/v1/repos/${owner}/${repoName}`,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    return response.data;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return null; // Repository doesn't exist
    }
    throw error;
  }
}

/**
 * Enhanced organization creation with better error handling and retry logic
 */
export async function getOrCreateGiteaOrgEnhanced({
  orgName,
  orgId,
  config,
  maxRetries = 3,
  retryDelay = 100,
}: {
  orgId?: string;
  orgName: string;
  config: Partial<Config>;
  maxRetries?: number;
  retryDelay?: number;
}): Promise<number> {
  if (!config.giteaConfig?.url || !config.giteaConfig?.token || !config.userId) {
    throw new Error("Gitea config is required.");
  }

  const decryptedConfig = decryptConfigTokens(config as Config);
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Org Creation] Attempting to get or create organization: ${orgName} (attempt ${attempt + 1}/${maxRetries})`);

      // Check if org exists
      try {
        const orgResponse = await httpGet<{ id: number }>(
          `${config.giteaConfig.url}/api/v1/orgs/${orgName}`,
          {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
          }
        );

        console.log(`[Org Creation] Organization ${orgName} already exists with ID: ${orgResponse.data.id}`);
        return orgResponse.data.id;
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) {
          throw error; // Unexpected error
        }
        // Organization doesn't exist, continue to create it
      }

      // Try to create the organization
      console.log(`[Org Creation] Organization ${orgName} not found. Creating new organization.`);

      const visibility = config.giteaConfig.visibility || "public";
      const createOrgPayload = {
        username: orgName,
        full_name: orgName === "starred" ? "Starred Repositories" : orgName,
        description: orgName === "starred" 
          ? "Repositories starred on GitHub" 
          : `Mirrored from GitHub organization: ${orgName}`,
        website: "",
        location: "",
        visibility: visibility,
      };

      try {
        const createResponse = await httpPost<{ id: number }>(
          `${config.giteaConfig.url}/api/v1/orgs`,
          createOrgPayload,
          {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
          }
        );

        console.log(`[Org Creation] Successfully created organization ${orgName} with ID: ${createResponse.data.id}`);
        
        await createMirrorJob({
          userId: config.userId,
          organizationId: orgId,
          organizationName: orgName,
          message: `Successfully created Gitea organization: ${orgName}`,
          status: "success",
          details: `Organization ${orgName} was created in Gitea with ID ${createResponse.data.id}.`,
        });

        return createResponse.data.id;
      } catch (createError) {
        // Check if it's a duplicate error
        if (createError instanceof HttpError) {
          const errorResponse = createError.response?.toLowerCase() || "";
          const isDuplicateError = 
            errorResponse.includes("duplicate") ||
            errorResponse.includes("already exists") ||
            errorResponse.includes("uqe_user_lower_name") ||
            errorResponse.includes("constraint");

          if (isDuplicateError && attempt < maxRetries - 1) {
            console.log(`[Org Creation] Organization creation failed due to duplicate. Will retry check.`);
            
            // Wait before retry with exponential backoff
            const delay = retryDelay * Math.pow(2, attempt);
            console.log(`[Org Creation] Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue; // Retry the loop
          }
        }
        throw createError;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      if (attempt === maxRetries - 1) {
        // Final attempt failed
        console.error(`[Org Creation] Failed to get or create organization ${orgName} after ${maxRetries} attempts: ${errorMessage}`);

        await createMirrorJob({
          userId: config.userId,
          organizationId: orgId,
          organizationName: orgName,
          message: `Failed to create or fetch Gitea organization: ${orgName}`,
          status: "failed",
          details: `Error after ${maxRetries} attempts: ${errorMessage}`,
        });

        throw new Error(`Failed to create organization ${orgName}: ${errorMessage}`);
      }

      // Log retry attempt
      console.warn(`[Org Creation] Attempt ${attempt + 1} failed for organization ${orgName}: ${errorMessage}. Retrying...`);
      
      // Wait before retry
      const delay = retryDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Should never reach here
  throw new Error(`Failed to create organization ${orgName} after ${maxRetries} attempts`);
}

/**
 * Enhanced sync operation that handles non-mirror repositories
 */
export async function syncGiteaRepoEnhanced({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: Repository;
}): Promise<any> {
  try {
    if (!config.userId || !config.giteaConfig?.url || !config.giteaConfig?.token) {
      throw new Error("Gitea config is required.");
    }

    const decryptedConfig = decryptConfigTokens(config as Config);

    console.log(`[Sync] Starting sync for repository ${repository.name}`);

    // Mark repo as "syncing" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("syncing"),
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id!));

    // Get the expected owner
    const { getGiteaRepoOwnerAsync } = await import("./gitea");
    const repoOwner = await getGiteaRepoOwnerAsync({ config, repository });

    // Check if repo exists and get its info
    const repoInfo = await getGiteaRepoInfo({
      config,
      owner: repoOwner,
      repoName: repository.name,
    });

    if (!repoInfo) {
      throw new Error(`Repository ${repository.name} not found in Gitea at ${repoOwner}/${repository.name}`);
    }

    // Check if it's a mirror repository
    if (!repoInfo.mirror) {
      console.warn(`[Sync] Repository ${repository.name} exists but is not configured as a mirror`);
      
      // Update database to reflect this status
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("failed"),
          updatedAt: new Date(),
          errorMessage: "Repository exists in Gitea but is not configured as a mirror. Manual intervention required.",
        })
        .where(eq(repositories.id, repository.id!));

      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Cannot sync ${repository.name}: Not a mirror repository`,
        details: `Repository ${repository.name} exists in Gitea but is not configured as a mirror. You may need to delete and recreate it as a mirror, or manually configure it as a mirror in Gitea.`,
        status: "failed",
      });

      throw new Error(`Repository ${repository.name} is not a mirror. Cannot sync.`);
    }

    // Perform the sync
    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repository.name}/mirror-sync`;

    try {
      const response = await httpPost(apiUrl, undefined, {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      });

      // Mark repo as "synced" in DB
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("synced"),
          updatedAt: new Date(),
          lastMirrored: new Date(),
          errorMessage: null,
          mirroredLocation: `${repoOwner}/${repository.name}`,
        })
        .where(eq(repositories.id, repository.id!));

      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Successfully synced repository: ${repository.name}`,
        details: `Repository ${repository.name} was synced with Gitea.`,
        status: "synced",
      });

      console.log(`[Sync] Repository ${repository.name} synced successfully`);
      return response.data;
    } catch (syncError) {
      if (syncError instanceof HttpError && syncError.status === 400) {
        // Handle specific mirror-sync errors
        const errorMessage = syncError.response?.toLowerCase() || "";
        if (errorMessage.includes("not a mirror")) {
          // Update status to indicate this specific error
          await db
            .update(repositories)
            .set({
              status: repoStatusEnum.parse("failed"),
              updatedAt: new Date(),
              errorMessage: "Repository is not configured as a mirror in Gitea",
            })
            .where(eq(repositories.id, repository.id!));

          await createMirrorJob({
            userId: config.userId,
            repositoryId: repository.id,
            repositoryName: repository.name,
            message: `Sync failed: ${repository.name} is not a mirror`,
            details: "The repository exists in Gitea but is not configured as a mirror. Manual intervention required.",
            status: "failed",
          });
        }
      }
      throw syncError;
    }
  } catch (error) {
    console.error(`[Sync] Error while syncing repository ${repository.name}:`, error);

    // Update repo with error status
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      })
      .where(eq(repositories.id, repository.id!));

    if (config.userId && repository.id && repository.name) {
      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Failed to sync repository: ${repository.name}`,
        details: error instanceof Error ? error.message : "Unknown error",
        status: "failed",
      });
    }

    throw error;
  }
}

/**
 * Delete a repository in Gitea (useful for cleaning up non-mirror repos)
 */
export async function deleteGiteaRepo({
  config,
  owner,
  repoName,
}: {
  config: Partial<Config>;
  owner: string;
  repoName: string;
}): Promise<void> {
  if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
    throw new Error("Gitea config is required.");
  }

  const decryptedConfig = decryptConfigTokens(config as Config);
  
  const response = await fetch(
    `${config.giteaConfig.url}/api/v1/repos/${owner}/${repoName}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete repository: ${response.statusText}`);
  }
}

/**
 * Convert a regular repository to a mirror (if supported by Gitea version)
 * Note: This might not be supported in all Gitea versions
 */
export async function convertToMirror({
  config,
  owner,
  repoName,
  cloneUrl,
}: {
  config: Partial<Config>;
  owner: string;
  repoName: string;
  cloneUrl: string;
}): Promise<boolean> {
  // This is a placeholder - actual implementation depends on Gitea API support
  // Most Gitea versions don't support converting existing repos to mirrors
  console.warn(`[Convert] Converting existing repositories to mirrors is not supported in most Gitea versions`);
  return false;
}

/**
 * Sequential organization creation to avoid race conditions
 */
export async function createOrganizationsSequentially({
  config,
  orgNames,
}: {
  config: Partial<Config>;
  orgNames: string[];
}): Promise<Map<string, number>> {
  const orgIdMap = new Map<string, number>();
  
  for (const orgName of orgNames) {
    try {
      const orgId = await getOrCreateGiteaOrgEnhanced({
        orgName,
        config,
        maxRetries: 3,
        retryDelay: 100,
      });
      orgIdMap.set(orgName, orgId);
    } catch (error) {
      console.error(`Failed to create organization ${orgName}:`, error);
      // Continue with other organizations
    }
  }
  
  return orgIdMap;
}

/**
 * Check and handle existing non-mirror repositories
 */
export async function handleExistingNonMirrorRepo({
  config,
  repository,
  repoInfo,
  strategy = "skip",
}: {
  config: Partial<Config>;
  repository: Repository;
  repoInfo: GiteaRepoInfo;
  strategy?: "skip" | "delete" | "rename";
}): Promise<void> {
  const owner = repoInfo.owner;
  const repoName = repoInfo.name;

  switch (strategy) {
    case "skip":
      console.log(`[Handle] Skipping existing non-mirror repository: ${owner}/${repoName}`);
      
      await db
        .update(repositories)
        .set({
          status: repoStatusEnum.parse("failed"),
          updatedAt: new Date(),
          errorMessage: "Repository exists but is not a mirror. Skipped.",
        })
        .where(eq(repositories.id, repository.id!));
      
      break;

    case "delete":
      console.log(`[Handle] Deleting existing non-mirror repository: ${owner}/${repoName}`);
      
      await deleteGiteaRepo({
        config,
        owner,
        repoName,
      });
      
      console.log(`[Handle] Deleted repository ${owner}/${repoName}. It can now be recreated as a mirror.`);
      break;

    case "rename":
      console.log(`[Handle] Renaming strategy not implemented yet for: ${owner}/${repoName}`);
      // TODO: Implement rename strategy if needed
      break;
  }
}