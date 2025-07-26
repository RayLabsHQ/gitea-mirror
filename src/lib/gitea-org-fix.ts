import type { Config } from "@/types/config";
import { createMirrorJob } from "./helpers";
import { decryptConfigTokens } from "./utils/config-encryption";

/**
 * Enhanced version of getOrCreateGiteaOrg with retry logic for race conditions
 * This implementation handles the duplicate organization constraint errors
 */
export async function getOrCreateGiteaOrgWithRetry({
  orgName,
  orgId,
  config,
  maxRetries = 3,
  retryDelay = 100,
}: {
  orgId?: string; // db id
  orgName: string;
  config: Partial<Config>;
  maxRetries?: number;
  retryDelay?: number;
}): Promise<number> {
  if (
    !config.giteaConfig?.url ||
    !config.giteaConfig?.token ||
    !config.userId
  ) {
    throw new Error("Gitea config is required.");
  }

  const decryptedConfig = decryptConfigTokens(config as Config);
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`Attempting to get or create Gitea organization: ${orgName} (attempt ${attempt + 1}/${maxRetries})`);

      // Check if org exists
      const orgRes = await fetch(
        `${config.giteaConfig.url}/api/v1/orgs/${orgName}`,
        {
          headers: {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (orgRes.ok) {
        // Organization exists, return its ID
        const contentType = orgRes.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
          throw new Error(
            `Invalid response format from Gitea API. Expected JSON but got: ${contentType}`
          );
        }

        const org = await orgRes.json();
        console.log(`Organization ${orgName} already exists with ID: ${org.id}`);
        
        await createMirrorJob({
          userId: config.userId,
          organizationId: orgId,
          organizationName: orgName,
          message: `Found existing Gitea organization: ${orgName}`,
          status: "success",
          details: `Organization ${orgName} already exists in Gitea with ID ${org.id}.`,
        });

        return org.id;
      }

      if (orgRes.status !== 404) {
        // Unexpected error
        const errorText = await orgRes.text();
        throw new Error(
          `Unexpected response from Gitea API: ${orgRes.status} ${orgRes.statusText}. Body: ${errorText}`
        );
      }

      // Organization doesn't exist, try to create it
      console.log(`Organization ${orgName} not found. Creating new organization.`);

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

      const createRes = await fetch(
        `${config.giteaConfig.url}/api/v1/orgs`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(createOrgPayload),
        }
      );

      if (createRes.ok) {
        // Successfully created
        const newOrg = await createRes.json();
        console.log(`Successfully created organization ${orgName} with ID: ${newOrg.id}`);

        await createMirrorJob({
          userId: config.userId,
          organizationId: orgId,
          organizationName: orgName,
          message: `Successfully created Gitea organization: ${orgName}`,
          status: "success",
          details: `Organization ${orgName} was created in Gitea with ID ${newOrg.id}.`,
        });

        return newOrg.id;
      }

      // Handle creation failure
      const createError = await createRes.json();
      
      // Check if it's a duplicate error
      if (
        createError.message?.includes("duplicate") ||
        createError.message?.includes("already exists") ||
        createError.message?.includes("UQE_user_lower_name")
      ) {
        console.log(`Organization creation failed due to duplicate. Will retry check.`);
        
        // Wait before retry with exponential backoff
        if (attempt < maxRetries - 1) {
          const delay = retryDelay * Math.pow(2, attempt);
          console.log(`Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; // Retry the loop
        }
      }

      // Non-retryable error
      throw new Error(
        `Failed to create organization ${orgName}: ${createError.message || createRes.statusText}`
      );

    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error occurred in getOrCreateGiteaOrg.";

      if (attempt === maxRetries - 1) {
        // Final attempt failed
        console.error(
          `Failed to get or create organization ${orgName} after ${maxRetries} attempts: ${errorMessage}`
        );

        await createMirrorJob({
          userId: config.userId,
          organizationId: orgId,
          organizationName: orgName,
          message: `Failed to create or fetch Gitea organization: ${orgName}`,
          status: "failed",
          details: `Error after ${maxRetries} attempts: ${errorMessage}`,
        });

        throw new Error(`Error in getOrCreateGiteaOrg: ${errorMessage}`);
      }

      // Log retry attempt
      console.warn(
        `Attempt ${attempt + 1} failed for organization ${orgName}: ${errorMessage}. Retrying...`
      );
      
      // Wait before retry
      const delay = retryDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Should never reach here
  throw new Error(`Failed to create organization ${orgName} after ${maxRetries} attempts`);
}

/**
 * Helper function to check if an error is retryable
 */
export function isRetryableOrgError(error: any): boolean {
  if (!error?.message) return false;
  
  const retryablePatterns = [
    "duplicate",
    "already exists",
    "UQE_user_lower_name",
    "constraint",
    "timeout",
    "ECONNREFUSED",
    "ENOTFOUND",
    "network"
  ];
  
  const errorMessage = error.message.toLowerCase();
  return retryablePatterns.some(pattern => errorMessage.includes(pattern));
}

/**
 * Pre-validate organization setup before bulk operations
 */
export async function validateOrgSetup({
  config,
  orgNames,
}: {
  config: Partial<Config>;
  orgNames: string[];
}): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];
  
  if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
    issues.push("Gitea configuration is missing");
    return { valid: false, issues };
  }

  const decryptedConfig = decryptConfigTokens(config as Config);
  
  for (const orgName of orgNames) {
    try {
      const response = await fetch(
        `${config.giteaConfig.url}/api/v1/orgs/${orgName}`,
        {
          headers: {
            Authorization: `token ${decryptedConfig.giteaConfig.token}`,
          },
        }
      );

      if (!response.ok && response.status !== 404) {
        issues.push(`Cannot check organization '${orgName}': ${response.statusText}`);
      }
    } catch (error) {
      issues.push(`Network error checking organization '${orgName}': ${error}`);
    }
  }

  // Check if user has permission to create organizations
  try {
    const userResponse = await fetch(
      `${config.giteaConfig.url}/api/v1/user`,
      {
        headers: {
          Authorization: `token ${decryptedConfig.giteaConfig.token}`,
        },
      }
    );

    if (userResponse.ok) {
      const user = await userResponse.json();
      if (user.prohibit_login) {
        issues.push("User account is prohibited from login");
      }
      if (user.restricted) {
        issues.push("User account is restricted");
      }
    }
  } catch (error) {
    issues.push(`Cannot verify user permissions: ${error}`);
  }

  return { valid: issues.length === 0, issues };
}