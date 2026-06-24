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
import { eq, and, ne } from "drizzle-orm";
import { decryptConfigTokens } from "./utils/config-encryption";
import { formatDateShort } from "./utils";
import { buildGithubSourceAuthPayload } from "./utils/mirror-source-auth";
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

  // Check if repository is starred
  if (repository.isStarred) {
    const starredReposMode = config.githubConfig.starredReposMode || "dedicated-org";
    if (starredReposMode === "preserve-owner") {
      return repository.organization || repository.owner;
    }
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

  // Check if repository is starred
  if (repository.isStarred) {
    const starredReposMode = config.githubConfig.starredReposMode || "dedicated-org";
    if (starredReposMode === "preserve-owner") {
      return repository.organization || repository.owner;
    }
    return config.githubConfig.starredReposOrg || "starred";
  }

  // Get the mirror strategy - use preserveOrgStructure for backward compatibility
  const mirrorStrategy = config.githubConfig.mirrorStrategy || 
    (config.giteaConfig.preserveOrgStructure ? "preserve" : "flat-user");
  const configuredGitHubOwner =
    (
      config.githubConfig.owner ||
      (config.githubConfig as typeof config.githubConfig & { username?: string }).username ||
      ""
    )
      .trim()
      .toLowerCase();

  switch (mirrorStrategy) {
    case "preserve":
      // Keep GitHub structure:
      // - org repos stay in the same org
      // - personal repos owned by other users keep their source owner namespace
      // - personal repos owned by the configured account go to defaultOwner
      if (repository.organization) {
        return repository.organization;
      }

      const normalizedRepoOwner = repository.owner.trim().toLowerCase();
      if (
        normalizedRepoOwner &&
        configuredGitHubOwner &&
        normalizedRepoOwner !== configuredGitHubOwner
      ) {
        return repository.owner;
      }

      // Personal repos from the configured GitHub account go to the configured default owner
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

const sanitizeTopicForGitea = (topic: string): string =>
  topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

const normalizeTopicsForGitea = (
  topics: string[],
  topicPrefix?: string
): string[] => {
  const normalizedPrefix = topicPrefix ? sanitizeTopicForGitea(topicPrefix) : "";
  const transformedTopics = topics
    .map((topic) => sanitizeTopicForGitea(topic))
    .filter((topic) => topic.length > 0)
    .map((topic) => (normalizedPrefix ? `${normalizedPrefix}-${topic}` : topic));

  return [...new Set(transformedTopics)];
};

const getSourceRepositoryCoordinates = (repository: Repository) => {
  const delimiterIndex = repository.fullName.indexOf("/");
  if (
    delimiterIndex > 0 &&
    delimiterIndex < repository.fullName.length - 1
  ) {
    return {
      owner: repository.fullName.slice(0, delimiterIndex),
      repo: repository.fullName.slice(delimiterIndex + 1),
    };
  }

  return {
    owner: repository.owner,
    repo: repository.name,
  };
};

const fetchGitHubTopics = async ({
  octokit,
  repository,
}: {
  octokit: Octokit;
  repository: Repository;
}): Promise<string[] | null> => {
  const { owner, repo } = getSourceRepositoryCoordinates(repository);

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/topics", {
      owner,
      repo,
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    const names = (response.data as { names?: unknown }).names;
    if (!Array.isArray(names)) {
      console.warn(
        `[Metadata] Unexpected topics payload for ${repository.fullName}; skipping topic sync.`
      );
      return null;
    }

    return names.filter((topic): topic is string => typeof topic === "string");
  } catch (error) {
    console.warn(
      `[Metadata] Failed to fetch topics from GitHub for ${repository.fullName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
};

const syncRepositoryMetadataToGitea = async ({
  config,
  octokit,
  repository,
  giteaOwner,
  giteaRepoName,
  giteaToken,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
  giteaRepoName: string;
  giteaToken: string;
}): Promise<void> => {
  const giteaBaseUrl = config.giteaConfig?.url;
  if (!giteaBaseUrl) {
    return;
  }

  const repoApiUrl = `${giteaBaseUrl}/api/v1/repos/${giteaOwner}/${giteaRepoName}`;
  const authHeaders = {
    Authorization: `token ${giteaToken}`,
  };
  const description = repository.description?.trim() || "";

  try {
    await httpPatch(
      repoApiUrl,
      { description },
      authHeaders
    );
    console.log(
      `[Metadata] Synced description for ${repository.fullName} to ${giteaOwner}/${giteaRepoName}`
    );
  } catch (error) {
    console.warn(
      `[Metadata] Failed to sync description for ${repository.fullName} to ${giteaOwner}/${giteaRepoName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (config.giteaConfig?.addTopics === false) {
    return;
  }

  const sourceTopics = await fetchGitHubTopics({ octokit, repository });
  if (sourceTopics === null) {
    console.warn(
      `[Metadata] Skipping topic sync for ${repository.fullName} because GitHub topics could not be fetched.`
    );
    return;
  }

  const topics = normalizeTopicsForGitea(
    sourceTopics,
    config.giteaConfig?.topicPrefix
  );

  try {
    await httpPut(
      `${repoApiUrl}/topics`,
      { topics },
      authHeaders
    );
    console.log(
      `[Metadata] Synced ${topics.length} topic(s) for ${repository.fullName} to ${giteaOwner}/${giteaRepoName}`
    );
  } catch (error) {
    console.warn(
      `[Metadata] Failed to sync topics for ${repository.fullName} to ${giteaOwner}/${giteaRepoName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
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
  // Declared here (not inside try) so the catch block can read it.
  // `let` is block-scoped — declaring inside try makes it inaccessible
  // from catch, which previously caused a ReferenceError that swallowed
  // the real error and left repos stuck in "mirroring" state.
  let migrateSucceeded = false;
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
    const mirrorStrategy = config.githubConfig.mirrorStrategy ||
      (config.giteaConfig.preserveOrgStructure ? "preserve" : "flat-user");
    const configuredGitHubOwner = (
      config.githubConfig.owner ||
      (config.githubConfig as typeof config.githubConfig & { username?: string }).username ||
      ""
    )
      .trim()
      .toLowerCase();
    const normalizedRepoOwner = repository.owner.trim().toLowerCase();
    const isExternalPersonalRepoInPreserveMode =
      mirrorStrategy === "preserve" &&
      !repository.organization &&
      !repository.isStarred &&
      normalizedRepoOwner !== "" &&
      configuredGitHubOwner !== "" &&
      normalizedRepoOwner !== configuredGitHubOwner;

    // Determine the actual repository name to use (handle duplicates for starred repos)
    let targetRepoName = repository.name;

    // REUSE-FIRST (issues #315 / #309): before generating any (suffixed) name,
    // check whether this exact source is already mirrored — either at the
    // recorded mirroredLocation or at the base name. If so, reuse that location
    // and route into the "already mirrored" handling below instead of creating
    // a duplicate. This must run before generateUniqueRepoName so the names
    // converge under concurrency (the in-flight guard then becomes effective).
    const { findExistingMirror } = await import("./utils/mirror-source-match");
    const existingMirror = await findExistingMirror({
      repository,
      config,
      candidateOwner: repoOwner,
      candidateName: repository.name,
    });

    if (existingMirror) {
      repoOwner = existingMirror.owner;
      targetRepoName = existingMirror.repoName;
      console.log(
        `Reusing existing same-source mirror for ${repository.fullName} at ${repoOwner}/${targetRepoName}`
      );
    } else if (
      repository.isStarred &&
      config.githubConfig &&
      (config.githubConfig.starredReposMode || "dedicated-org") === "dedicated-org"
    ) {
      // Extract GitHub owner from full_name (format: owner/repo)
      const githubOwner = repository.fullName.split('/')[0];

      targetRepoName = await generateUniqueRepoName({
        config,
        orgName: repoOwner,
        baseName: repository.name,
        githubOwner,
        fullName: repository.fullName,
        strategy: config.githubConfig.starredDuplicateStrategy,
        sourceCloneUrl: repository.cloneUrl,
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
      const { getGiteaRepoInfo, handleExistingNonMirrorRepo } = await import("./gitea-enhanced");
      const existingRepoInfo = await getGiteaRepoInfo({
        config,
        owner: repoOwner,
        repoName: targetRepoName,
      });

      if (existingRepoInfo && !existingRepoInfo.mirror) {
        console.log(`Repository ${targetRepoName} exists but is not a mirror. Handling...`);
        await handleExistingNonMirrorRepo({
          config,
          repository,
          repoInfo: existingRepoInfo,
          strategy: "delete", // Can be configured: "skip", "delete", or "rename"
        });
      } else if (existingRepoInfo?.mirror) {
        // PHANTOM-FORK GUARD (#309): a mirror at this name is only "ours" if it
        // mirrors THIS source. existingMirror short-circuits the check
        // because findExistingMirror already confirmed the source match.
        const { isMirrorOfSource } = await import("./utils/mirror-source-match");
        const sameSource =
          !!existingMirror ||
          isMirrorOfSource(existingRepoInfo, repository.cloneUrl);

        if (!sameSource) {
          // A different source occupies this name. Treat as a genuine collision:
          // generate a unique name and fall through to create a separate mirror.
          console.warn(
            `[Mirror] ${repoOwner}/${targetRepoName} is a mirror of a different source. ` +
            `Generating a unique name for ${repository.fullName} to avoid overwriting it.`
          );
          targetRepoName = await generateUniqueRepoName({
            config,
            orgName: repoOwner,
            baseName: repository.name,
            githubOwner: repository.fullName.split("/")[0],
            fullName: repository.fullName,
            strategy: config.githubConfig?.starredDuplicateStrategy,
            sourceCloneUrl: repository.cloneUrl,
          });
          // expectedLocation is recomputed below before the "mirroring" write.
        } else {
          console.log(
            `Repository ${targetRepoName} already exists in Gitea under ${repoOwner}. Updating database status.`
          );

          await syncRepositoryMetadataToGitea({
            config,
            octokit,
            repository,
            giteaOwner: repoOwner,
            giteaRepoName: targetRepoName,
            giteaToken: decryptedConfig.giteaConfig.token,
          });

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
      } else {
        console.warn(
          `[Mirror] Repository ${repoOwner}/${targetRepoName} exists but mirror status could not be verified. Continuing with mirror creation flow.`
        );
      }
    }

    // Recompute the target location in case a phantom-fork collision above
    // forced a renamed target after the initial expectedLocation was derived.
    const targetLocation = `${repoOwner}/${targetRepoName}`;

    console.log(`Mirroring repository ${repository.name}`);

    // DOUBLE-CHECK: Final idempotency check right before updating status
    // This catches race conditions in the small window between first check and status update
    const finalCheck = await isRepoCurrentlyMirroring({
      config,
      repoName: targetRepoName,
      expectedLocation: targetLocation,
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
        mirroredLocation: targetLocation,
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
          if (isExternalPersonalRepoInPreserveMode) {
            throw new Error(
              `Cannot create/access namespace "${repoOwner}" for ${repository.fullName}. ` +
              `Refusing fallback to "${config.giteaConfig.defaultOwner}" in preserve mode to avoid cross-owner overwrite.`
            );
          }

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
      description: repository.description?.trim() || "",
      service: "git",
    };

    // Always send authentication credentials so Gitea/Forgejo stores them
    // for subsequent mirror fetches. This prevents "terminal prompts disabled"
    // errors on public repos and raises GitHub API rate limits.
    {
      const githubOwner =
        (
          config.githubConfig as typeof config.githubConfig & {
            owner?: string;
          }
        ).owner || "";

      Object.assign(
        migratePayload,
        buildGithubSourceAuthPayload({
          token: decryptedConfig.githubConfig.token,
          githubOwner,
          githubUsername: config.githubConfig.username,
          repositoryOwner: repository.owner,
        })
      );
    }

    const response = await httpPost(
      apiUrl,
      migratePayload,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    migrateSucceeded = true;

    await syncRepositoryMetadataToGitea({
      config,
      octokit,
      repository,
      giteaOwner: repoOwner,
      giteaRepoName: targetRepoName,
      giteaToken: decryptedConfig.giteaConfig.token,
    });

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

    // Reconcile metadata on every sync (matches the release path above).
    // The underlying mirror* functions are idempotent: issues/PRs are
    // matched via [GH-ISSUE #N] / [GH-PR #N] markers and PATCHed in place,
    // labels are deduped by name, milestones by title.
    const shouldMirrorIssuesThisRun =
      !!config.giteaConfig?.mirrorIssues && !skipMetadataForStarred;

    console.log(
      `[Metadata] Issue mirroring check: mirrorIssues=${config.giteaConfig?.mirrorIssues}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorIssues=${shouldMirrorIssuesThisRun}`
    );

    if (shouldMirrorIssuesThisRun) {
      try {
        await mirrorGitRepoIssuesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.issues = true;
        metadataState.components.labels = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored issues for ${repository.name}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror issues for ${repository.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if issues fail
      }
    }

    const shouldMirrorPullRequests =
      !!config.giteaConfig?.mirrorPullRequests && !skipMetadataForStarred;

    console.log(
      `[Metadata] Pull request mirroring check: mirrorPullRequests=${config.giteaConfig?.mirrorPullRequests}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorPullRequests=${shouldMirrorPullRequests}`
    );

    if (shouldMirrorPullRequests) {
      try {
        await mirrorGitRepoPullRequestsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: repoOwner,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.pullRequests = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored pull requests for ${repository.name}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror pull requests for ${repository.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if PRs fail
      }
    }

    // Labels-only path; issues run above already creates/reconciles labels.
    const shouldMirrorLabels =
      !!config.giteaConfig?.mirrorLabels &&
      !skipMetadataForStarred &&
      !shouldMirrorIssuesThisRun;

    console.log(
      `[Metadata] Label mirroring check: mirrorLabels=${config.giteaConfig?.mirrorLabels}, issuesRunning=${shouldMirrorIssuesThisRun}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorLabels=${shouldMirrorLabels}`
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
    }

    const shouldMirrorMilestones =
      !!config.giteaConfig?.mirrorMilestones && !skipMetadataForStarred;

    console.log(
      `[Metadata] Milestone mirroring check: mirrorMilestones=${config.giteaConfig?.mirrorMilestones}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorMilestones=${shouldMirrorMilestones}`
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

    // Mark repos as "failed" in DB. Only clear mirroredLocation if the Gitea
    // migrate call itself failed (repo doesn't exist in Gitea). If migrate
    // succeeded but metadata mirroring failed, preserve the location since
    // the repo physically exists and we need the location for recovery/retry.
    const failureUpdate: Record<string, any> = {
      status: repoStatusEnum.parse("failed"),
      updatedAt: new Date(),
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    };
    if (!migrateSucceeded) {
      failureUpdate.mirroredLocation = "";
    }
    await db
      .update(repositories)
      .set(failureUpdate)
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
 * Check if a candidate mirroredLocation is already claimed by another repository
 * in the local database. This prevents race conditions during concurrent batch
 * mirroring where two repos could both claim the same name before either
 * finishes creating in Gitea.
 */
async function isMirroredLocationClaimedInDb({
  userId,
  candidateLocation,
  excludeFullName,
}: {
  userId: string;
  candidateLocation: string;
  excludeFullName: string;
}): Promise<boolean> {
  try {
    const existing = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, userId),
          eq(repositories.mirroredLocation, candidateLocation),
          ne(repositories.fullName, excludeFullName)
        )
      )
      .limit(1);

    return existing.length > 0;
  } catch (error) {
    console.error(
      `Error checking DB for mirroredLocation "${candidateLocation}":`,
      error
    );
    // Fail-closed: assume claimed to be conservative and prevent collisions
    return true;
  }
}

/**
 * Generate a unique repository name for starred repos with duplicate names.
 * Checks both the Gitea instance (HTTP) and the local DB (mirroredLocation)
 * to reduce collisions during concurrent batch mirroring.
 *
 * Source-aware (issues #315 / #309): when a candidate name is already occupied
 * by a mirror of THIS SAME GitHub source, the name is REUSED rather than
 * suffixed — this is what previously caused starred repos to spawn `-owner`,
 * `-owner-1`, … duplicates on every re-mirror. Suffixing only happens on a
 * genuine different-source collision (preserving the #95/#236 cross-owner
 * behavior). The per-user DB claim check is retained so two users mirroring the
 * same source into a shared org stay separated.
 *
 * NOTE: This function only checks availability — it does NOT claim the name.
 * The actual claim happens later when mirroredLocation is written at the
 * status="mirroring" DB update, which is protected by a unique partial index
 * on (userId, mirroredLocation) WHERE mirroredLocation != ''.
 */
async function generateUniqueRepoName({
  config,
  orgName,
  baseName,
  githubOwner,
  fullName,
  strategy,
  sourceCloneUrl,
}: {
  config: Partial<Config>;
  orgName: string;
  baseName: string;
  githubOwner: string;
  fullName: string;
  strategy?: string;
  // Source GitHub clone URL, used to decide whether an occupied name belongs to
  // THIS repo's mirror (reuse) or a different source (suffix). When omitted,
  // behavior degrades to the legacy "any occupant collides" semantics.
  sourceCloneUrl?: string;
}): Promise<string> {
  if (!fullName?.includes("/")) {
    throw new Error(
      `Invalid fullName "${fullName}" for starred repo dedup — expected "owner/repo" format`
    );
  }

  const duplicateStrategy = strategy || "suffix";
  const userId = config.userId || "";

  const { getGiteaRepoInfo } = await import("./gitea-enhanced");
  const { classifyCandidateName } = await import("./utils/mirror-source-match");

  // Resolve the I/O for a candidate name (Gitea existence, DB claim, repo info)
  // and defer the available/reusable/taken decision to the pure, unit-tested
  // classifyCandidateName helper.
  const classifyName = async (candidateName: string) => {
    const existsInGitea = await isRepoPresentInGitea({
      config,
      owner: orgName,
      repoName: candidateName,
    });

    // A DB claim by a DIFFERENT repo (concurrent batch) always blocks reuse.
    let claimedByOther = false;
    if (userId) {
      claimedByOther = await isMirroredLocationClaimedInDb({
        userId,
        candidateLocation: `${orgName}/${candidateName}`,
        excludeFullName: fullName,
      });
    }

    // Only fetch repo info when it can actually change the decision (existing,
    // same-source candidate that is not DB-claimed by another repo).
    const repoInfo =
      existsInGitea && sourceCloneUrl && !claimedByOther
        ? await getGiteaRepoInfo({
            config,
            owner: orgName,
            repoName: candidateName,
          })
        : null;

    return classifyCandidateName({
      existsInGitea,
      claimedByOther,
      repoInfo,
      sourceCloneUrl,
    });
  };

  // First check the base name — reuse it if it already holds our own mirror.
  const baseClass = await classifyName(baseName);
  if (baseClass === "available") {
    return baseName;
  }
  if (baseClass === "reusable") {
    console.log(`Reusing existing same-source mirror name: ${orgName}/${baseName}`);
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

    const candidateClass = await classifyName(candidateName);

    if (candidateClass === "reusable") {
      console.log(`Reusing existing same-source mirror name: ${orgName}/${candidateName}`);
      return candidateName;
    }

    if (candidateClass === "available") {
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
  // Declared here (not inside try) so the catch block can read it.
  // See note in mirrorGithubRepoToGitea for the scoping bug this prevents.
  let migrateSucceeded = false;
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
    // The org we will record/reuse for. Stays === orgName on the create path
    // (migration uses orgName + giteaOrgId); a reuse hit may repoint it to the
    // recorded mirroredLocation's owner for the early-return DB update.
    let targetOwner = orgName;

    // REUSE-FIRST (issues #315 / #309): reuse an existing same-source mirror
    // before generating any suffixed name. See mirrorGithubRepoToGitea for the
    // rationale. Routes a hit into the "already mirrored" handling below.
    const { findExistingMirror } = await import("./utils/mirror-source-match");
    const existingMirror = await findExistingMirror({
      repository,
      config,
      candidateOwner: orgName,
      candidateName: repository.name,
    });

    if (existingMirror) {
      targetOwner = existingMirror.owner;
      targetRepoName = existingMirror.repoName;
      console.log(
        `Reusing existing same-source mirror for ${repository.fullName} at ${targetOwner}/${targetRepoName}`
      );
    } else if (
      repository.isStarred &&
      config.githubConfig &&
      (config.githubConfig.starredReposMode || "dedicated-org") === "dedicated-org"
    ) {
      // Extract GitHub owner from full_name (format: owner/repo)
      const githubOwner = repository.fullName.split('/')[0];

      targetRepoName = await generateUniqueRepoName({
        config,
        orgName,
        baseName: repository.name,
        githubOwner,
        fullName: repository.fullName,
        strategy: config.githubConfig.starredDuplicateStrategy,
        sourceCloneUrl: repository.cloneUrl,
      });

      if (targetRepoName !== repository.name) {
        console.log(
          `Starred repo ${repository.fullName} will be mirrored as ${orgName}/${targetRepoName} to avoid naming conflict`
        );
      }
    }

    // IDEMPOTENCY CHECK: Check if this repo is already being mirrored
    const expectedLocation = `${targetOwner}/${targetRepoName}`;
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
      owner: targetOwner,
      repoName: targetRepoName,
    });

    if (isExisting) {
      const { getGiteaRepoInfo, handleExistingNonMirrorRepo } = await import("./gitea-enhanced");
      const existingRepoInfo = await getGiteaRepoInfo({
        config,
        owner: targetOwner,
        repoName: targetRepoName,
      });

      if (existingRepoInfo && !existingRepoInfo.mirror) {
        console.log(`Repository ${targetRepoName} exists but is not a mirror. Handling...`);
        await handleExistingNonMirrorRepo({
          config,
          repository,
          repoInfo: existingRepoInfo,
          strategy: "delete", // Can be configured: "skip", "delete", or "rename"
        });
      } else if (existingRepoInfo?.mirror) {
        // PHANTOM-FORK GUARD (#309): only treat this as "ours" if it mirrors
        // THIS source. existingMirror short-circuits because findExistingMirror already
        // confirmed the source match.
        const { isMirrorOfSource } = await import("./utils/mirror-source-match");
        const sameSource =
          !!existingMirror ||
          isMirrorOfSource(existingRepoInfo, repository.cloneUrl);

        if (!sameSource) {
          // Different source occupies this name: generate a unique name and
          // fall through to create a separate mirror under orgName/giteaOrgId.
          console.warn(
            `[Mirror] ${targetOwner}/${targetRepoName} is a mirror of a different source. ` +
            `Generating a unique name for ${repository.fullName} to avoid overwriting it.`
          );
          targetOwner = orgName;
          targetRepoName = await generateUniqueRepoName({
            config,
            orgName,
            baseName: repository.name,
            githubOwner: repository.fullName.split("/")[0],
            fullName: repository.fullName,
            strategy: config.githubConfig?.starredDuplicateStrategy,
            sourceCloneUrl: repository.cloneUrl,
          });
        } else {
          console.log(
            `Repository ${targetRepoName} already exists in Gitea organization ${targetOwner}. Updating database status.`
          );

          await syncRepositoryMetadataToGitea({
            config,
            octokit,
            repository,
            giteaOwner: targetOwner,
            giteaRepoName: targetRepoName,
            giteaToken: decryptedConfig.giteaConfig.token,
          });

          // Update database to reflect that the repository is already mirrored
          await db
            .update(repositories)
            .set({
              status: repoStatusEnum.parse("mirrored"),
              updatedAt: new Date(),
              lastMirrored: new Date(),
              errorMessage: null,
              mirroredLocation: `${targetOwner}/${targetRepoName}`,
            })
            .where(eq(repositories.id, repository.id!));

          // Create a mirror job log entry
          await createMirrorJob({
            userId: config.userId,
            repositoryId: repository.id,
            repositoryName: repository.name,
            message: `Repository ${targetRepoName} already exists in Gitea organization ${targetOwner}`,
            details: `Repository ${targetRepoName} was found to already exist in Gitea organization ${targetOwner} and database status was updated.`,
            status: "mirrored",
          });

          console.log(
            `Repository ${targetRepoName} database status updated to mirrored in organization ${targetOwner}`
          );
          return;
        }
      } else {
        console.warn(
          `[Mirror] Repository ${targetOwner}/${targetRepoName} exists but mirror status could not be verified. Continuing with mirror creation flow.`
        );
      }
    }

    // Recompute the target location in case a phantom-fork collision above
    // forced a renamed target after the initial expectedLocation was derived.
    const targetLocation = `${orgName}/${targetRepoName}`;

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
      expectedLocation: targetLocation,
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
        mirroredLocation: targetLocation,
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
      description: repository.description?.trim() || "",
      service: "git",
    };

    // Always send authentication credentials so Gitea/Forgejo stores them
    // for subsequent mirror fetches. This prevents "terminal prompts disabled"
    // errors on public repos and raises GitHub API rate limits.
    {
      const githubOwner =
        (
          config.githubConfig as typeof config.githubConfig & {
            owner?: string;
          }
        )?.owner || "";

      Object.assign(
        migratePayload,
        buildGithubSourceAuthPayload({
          token: decryptedConfig.githubConfig?.token,
          githubOwner,
          githubUsername: config.githubConfig?.username,
          repositoryOwner: repository.owner,
        })
      );
    }

    const migrateRes = await httpPost(
      apiUrl,
      migratePayload,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    migrateSucceeded = true;

    await syncRepositoryMetadataToGitea({
      config,
      octokit,
      repository,
      giteaOwner: orgName,
      giteaRepoName: targetRepoName,
      giteaToken: decryptedConfig.giteaConfig.token,
    });

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

    // Reconcile metadata on every sync. See note in mirrorGithubRepoToGitea
    // above. The underlying mirror* functions are idempotent.
    const shouldMirrorIssuesThisRun =
      !!config.giteaConfig?.mirrorIssues && !skipMetadataForStarred;

    console.log(
      `[Metadata] Issue mirroring check: mirrorIssues=${config.giteaConfig?.mirrorIssues}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorIssues=${shouldMirrorIssuesThisRun}`
    );

    if (shouldMirrorIssuesThisRun) {
      try {
        await mirrorGitRepoIssuesToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.issues = true;
        metadataState.components.labels = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored issues for ${repository.name} to org ${orgName}/${targetRepoName}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror issues for ${repository.name} to org ${orgName}/${targetRepoName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if issues fail
      }
    }

    const shouldMirrorPullRequests =
      !!config.giteaConfig?.mirrorPullRequests && !skipMetadataForStarred;

    console.log(
      `[Metadata] Pull request mirroring check: mirrorPullRequests=${config.giteaConfig?.mirrorPullRequests}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorPullRequests=${shouldMirrorPullRequests}`
    );

    if (shouldMirrorPullRequests) {
      try {
        await mirrorGitRepoPullRequestsToGitea({
          config,
          octokit,
          repository,
          giteaOwner: orgName,
          giteaRepoName: targetRepoName,
        });
        metadataState.components.pullRequests = true;
        metadataUpdated = true;
        console.log(
          `[Metadata] Successfully mirrored pull requests for ${repository.name} to org ${orgName}/${targetRepoName}`
        );
      } catch (error) {
        console.error(
          `[Metadata] Failed to mirror pull requests for ${repository.name} to org ${orgName}/${targetRepoName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue with other metadata operations even if PRs fail
      }
    }

    // Labels-only path; issues run above already creates/reconciles labels.
    const shouldMirrorLabels =
      !!config.giteaConfig?.mirrorLabels &&
      !skipMetadataForStarred &&
      !shouldMirrorIssuesThisRun;

    console.log(
      `[Metadata] Label mirroring check: mirrorLabels=${config.giteaConfig?.mirrorLabels}, issuesRunning=${shouldMirrorIssuesThisRun}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorLabels=${shouldMirrorLabels}`
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
    }

    const shouldMirrorMilestones =
      !!config.giteaConfig?.mirrorMilestones && !skipMetadataForStarred;

    console.log(
      `[Metadata] Milestone mirroring check: mirrorMilestones=${config.giteaConfig?.mirrorMilestones}, isStarred=${repository.isStarred}, starredCodeOnly=${config.githubConfig?.starredCodeOnly}, shouldMirrorMilestones=${shouldMirrorMilestones}`
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
    // Mark repos as "failed" in DB. For starred repos, clear mirroredLocation
    // to release the name claim for retry. For non-starred repos, preserve it
    // since the Gitea repo may partially exist and we need the location for recovery.
    const failureUpdate2: Record<string, any> = {
      status: repoStatusEnum.parse("failed"),
      updatedAt: new Date(),
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    };
    // Only clear mirroredLocation if the Gitea migrate call itself failed.
    // If migrate succeeded but metadata mirroring failed, preserve the
    // location since the repo physically exists in Gitea.
    if (!migrateSucceeded) {
      failureUpdate2.mirroredLocation = "";
    }
    await db
      .update(repositories)
      .set(failureUpdate2)
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
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
  giteaRepoName?: string;
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

  // Fetch GitHub issues
  const issues = await octokit.paginate(
    octokit.rest.issues.listForRepo,
    {
      owner,
      repo,
      state: "all",
      per_page: 100,
      sort: "created",
      direction: "asc",
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

  const ghIssueMarkerRegex = /\[GH-ISSUE #(\d+)\]/i;
  const extractGitHubIssueNumber = (value: string | null | undefined): number | null => {
    if (!value) return null;
    const match = value.match(ghIssueMarkerRegex);
    if (!match?.[1]) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const existingGiteaIssues: any[] = [];
  const titleFallbackMap = new Map<string, any[]>();
  const giteaIssueByGitHubNumber = new Map<number, any>();
  let issuesPage = 1;
  const issuesPerPage = 100;

  while (true) {
    const existingIssuesRes = await httpGet(
      `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/issues?state=all&page=${issuesPage}&limit=${issuesPerPage}`,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );

    const pageIssues = Array.isArray(existingIssuesRes.data)
      ? existingIssuesRes.data
      : [];
    if (!pageIssues.length) break;

    existingGiteaIssues.push(...pageIssues);

    // Use the Link header (RFC 5988) to decide whether more pages
    // exist. The old short-page-length heuristic was wrong in both
    // directions:
    //   - Gitea caps response size at `[api].MAX_RESPONSE_ITEMS`
    //     (default 50), typically lower than `issuesPerPage` (100),
    //     so the very first page already looks "short" and
    //     pagination terminated after 50 items — every issue past
    //     that was misclassified as new and duplicated on every sync.
    //   - For some endpoints Gitea returns the same data on every
    //     page when the page is past the end, so a naive "break on
    //     empty" alone can loop forever if the server doesn't return
    //     []. Link header is the safe signal.
    const linkHeader = existingIssuesRes.headers.get("link") || "";
    if (!/\brel="next"/.test(linkHeader)) break;
    issuesPage += 1;
  }

  for (const giteaIssue of existingGiteaIssues) {
    const mappedNumber = extractGitHubIssueNumber(giteaIssue.title);
    if (mappedNumber !== null) {
      giteaIssueByGitHubNumber.set(mappedNumber, giteaIssue);
      continue;
    }

    const title = (giteaIssue.title || "").trim();
    if (!title) continue;
    const existing = titleFallbackMap.get(title) || [];
    existing.push(giteaIssue);
    titleFallbackMap.set(title, existing);
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
      const issueMarker = `[GH-ISSUE #${issue.number}]`;
      const mirroredTitle = `${issueMarker} ${issue.title}`;
      const issueBody = `${issueOriginHeader}\nOriginal GitHub issue: ${issue.html_url}${originalAssignees}\n\n${issue.body ?? ""}`;

      const issuePayload: any = {
        title: mirroredTitle,
        body: issueBody,
        closed: issue.state === "closed",
        labels: giteaLabelIds,
      };

      let existingIssue = giteaIssueByGitHubNumber.get(issue.number);
      if (!existingIssue) {
        const titleFallbackCandidates = titleFallbackMap.get(issue.title.trim()) || [];
        if (titleFallbackCandidates.length === 1) {
          existingIssue = titleFallbackCandidates[0];
          giteaIssueByGitHubNumber.set(issue.number, existingIssue);
          console.log(
            `[Issues] Matched legacy issue by title for #${issue.number}; converting to marker-based title`
          );
        } else if (titleFallbackCandidates.length > 1) {
          const filtered = titleFallbackCandidates.filter((candidate) =>
            String(candidate.body || "").startsWith(issueOriginHeader)
          );
          if (filtered.length === 1) {
            existingIssue = filtered[0];
            giteaIssueByGitHubNumber.set(issue.number, existingIssue);
            console.log(
              `[Issues] Matched legacy issue by body prefix for #${issue.number}; converting to marker-based title`
            );
          }
        }
      }

      let targetIssueNumber: number;
      if (existingIssue) {
        targetIssueNumber = existingIssue.number;
        await httpPatch(
          `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${targetIssueNumber}`,
          {
            title: issuePayload.title,
            body: issuePayload.body,
            state: issue.state === "closed" ? "closed" : "open",
            labels: issuePayload.labels,
          },
          {
            Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
          }
        );
      } else {
        // Defensive recheck before create: a previous retry attempt may
        // have already created this issue and then thrown. The common
        // trigger is Gitea's CreateIssue handler committing the issue
        // insert in one transaction and then deadlocking on the
        // addLabel / repository counter update in a second transaction.
        // The issue row is committed and visible, but the in-memory
        // giteaIssueByGitHubNumber map (built once at function entry)
        // doesn't know about it, so without this check processWithRetry
        // would create a duplicate every time the create returns 5xx
        // after a partial commit.
        //
        // Reproduces deterministically on MySQL (Error 1213 / 40001)
        // and PostgreSQL (40P01); SQLite escapes because writes
        // serialize globally.
        let recheckHit: any = null;
        try {
          const recheck = await httpGet(
            `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues?state=all&type=issues&q=${encodeURIComponent(`[GH-ISSUE #${issue.number}]`)}`,
            {
              Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
            }
          );
          const candidates = Array.isArray(recheck.data) ? recheck.data : [];
          recheckHit = candidates.find(
            (c: any) => extractGitHubIssueNumber(c.title) === issue.number
          ) ?? null;
        } catch (_recheckErr) {
          // Best-effort; fall through to create.
        }

        if (recheckHit) {
          giteaIssueByGitHubNumber.set(issue.number, recheckHit);
          existingIssue = recheckHit;
          targetIssueNumber = recheckHit.number;
          console.log(
            `[Issues] Recovered orphan from prior failed attempt for #${issue.number}; switching to PATCH`
          );
          await httpPatch(
            `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${targetIssueNumber}`,
            {
              title: issuePayload.title,
              body: issuePayload.body,
              state: issue.state === "closed" ? "closed" : "open",
              labels: issuePayload.labels,
            },
            {
              Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
            }
          );
        } else {
          const createdIssue = await httpPost(
            `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues`,
            issuePayload,
            {
              Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
            }
          );
          targetIssueNumber = createdIssue.data.number;
          // Cache the new issue immediately so a subsequent retry of
          // this callback (e.g. triggered by a later step like comment
          // sync failing) doesn't lose track of it.
          giteaIssueByGitHubNumber.set(issue.number, createdIssue.data);

          if (issue.state === "closed" && createdIssue.data.state !== "closed") {
            try {
              await httpPatch(
                `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${targetIssueNumber}`,
                { state: "closed" },
                {
                  Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
                }
              );
            } catch (closeError) {
              console.error(
                `[Issues] Failed to close issue #${targetIssueNumber}: ${
                  closeError instanceof Error ? closeError.message : String(closeError)
                }`
              );
            }
          }
        }
      }

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
        const existingComments: any[] = [];
        let commentsPage = 1;
        const commentsPerPage = 100;
        while (true) {
          const existingCommentsRes = await httpGet(
            `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${targetIssueNumber}/comments?page=${commentsPage}&limit=${commentsPerPage}`,
            {
              Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
            }
          );
          const pageComments = Array.isArray(existingCommentsRes.data)
            ? existingCommentsRes.data
            : [];
          if (!pageComments.length) break;
          existingComments.push(...pageComments);
          // Use the Link header to decide whether more pages exist.
          // See note on the existing-issues pagination above; the
          // same Gitea behaviors (MAX_RESPONSE_ITEMS cap and
          // repeated-data on out-of-bound pages) apply here.
          const commentsLinkHeader =
            existingCommentsRes.headers.get("link") || "";
          if (!/\brel="next"/.test(commentsLinkHeader)) break;
          commentsPage += 1;
        }
        const mirroredCommentIds = new Set<number>();
        const existingCommentBodies = new Set<string>();
        for (const existingComment of existingComments) {
          const body = String(existingComment.body || "");
          if (body) existingCommentBodies.add(body);
          const marker = String(existingComment.body || "").match(
            /<!--\s*gh-comment-id:(\d+)\s*-->/i
          );
          if (marker?.[1]) {
            const parsed = Number.parseInt(marker[1], 10);
            if (Number.isFinite(parsed)) mirroredCommentIds.add(parsed);
          }
        }

        await processWithRetry(
          sortedComments,
          async (comment) => {
            if (mirroredCommentIds.has(comment.id)) {
              return comment;
            }
            const commenter = comment.user?.login ?? "unknown";
            const commentDate = formatDateShort(comment.created_at);
            const commentHeader = `@${commenter} commented on GitHub${
              commentDate ? ` (${commentDate})` : ""
            }:`;
            const legacyBody = `${commentHeader}\n\n${comment.body ?? ""}`;
            const markedBody = `<!-- gh-comment-id:${comment.id} -->\n${legacyBody}`;
            if (existingCommentBodies.has(legacyBody) || existingCommentBodies.has(markedBody)) {
              return comment;
            }

            await httpPost(
              `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${targetIssueNumber}/comments`,
              {
                body: markedBody,
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

  console.log(
    `Completed mirroring ${filteredIssues.length} issues for ${repository.fullName}`
  );
};

/**
 * Classify a set of GitHub releases against the set already present in Gitea.
 *
 * Returns:
 *   - `toCreate`: tag names that exist on GitHub but are missing from Gitea
 *   - `toSkip`:   tag names that already exist in Gitea (will be handled by PATCH-if-content-changed)
 *
 * Deliberately does NOT return anything to delete based on ordering — Gitea mirrors
 * order releases by tag-commit date, which can permanently disagree with GitHub's
 * published_at order (e.g. unaconfig_dart v0.1.0/v0.1.1 — #310). Destroying and
 * re-emitting releases for a cosmetic display-order difference is never worth it.
 */
export function classifyReleasesForReconciliation(
  githubTagNames: string[],
  giteaTagNames: string[]
): { toCreate: string[]; toSkip: string[] } {
  const giteaSet = new Set(giteaTagNames);
  const toCreate: string[] = [];
  const toSkip: string[] = [];

  for (const tag of githubTagNames) {
    if (giteaSet.has(tag)) {
      toSkip.push(tag);
    } else {
      toCreate.push(tag);
    }
  }

  return { toCreate, toSkip };
}

/**
 * Decide which of a GitHub release's assets need (re)uploading to Gitea.
 *
 * Compared by name:
 *   - present in Gitea with a matching size  -> skip (already mirrored)
 *   - present with a different size          -> upload, replacing the stale copy
 *   - absent                                 -> upload (fresh)
 *
 * Pure function so the create/update reconciliation decision is unit-testable
 * without hitting the network (regression guard for #331).
 */
export function classifyAssetsForReconciliation(
  githubAssets: Array<{ name: string; size: number }>,
  giteaAssets: Array<{ id: number; name: string; size: number }>
): {
  toUpload: Array<{ name: string; replaceAssetId: number | null }>;
  toSkip: string[];
} {
  const existingByName = new Map(giteaAssets.map((a) => [a.name, a]));
  const toUpload: Array<{ name: string; replaceAssetId: number | null }> = [];
  const toSkip: string[] = [];

  for (const asset of githubAssets) {
    const existing = existingByName.get(asset.name);
    if (existing && existing.size === asset.size) {
      toSkip.push(asset.name);
    } else {
      toUpload.push({ name: asset.name, replaceAssetId: existing ? existing.id : null });
    }
  }

  return { toUpload, toSkip };
}

/**
 * Idempotently mirror a GitHub release's assets onto the matching Gitea release.
 *
 * Runs on BOTH the create and update paths so assets are reconciled on every sync,
 * not only on the single sync where the Gitea release is first created. Previously
 * assets were uploaded inline in the create path only; the update path PATCHed the
 * body and `continue`d without ever looking at assets. Any release whose assets
 * failed or were interrupted on first creation therefore stayed permanently
 * asset-less, and re-syncing could never heal it (#331).
 *
 * Strategy: compare by asset name. Skip assets already present with a matching size;
 * (re)upload anything missing, and replace an existing asset whose size differs
 * (truncated/changed upstream). Returns per-release counts so the caller can report.
 */
async function reconcileReleaseAssets({
  config,
  decryptedConfig,
  repoOwner,
  repoName,
  giteaReleaseId,
  githubAssets,
  tagName,
}: {
  config: Partial<Config>;
  decryptedConfig: Config;
  repoOwner: string;
  repoName: string;
  giteaReleaseId: number;
  githubAssets: Array<{ name: string; size: number; browser_download_url: string }>;
  tagName: string;
}): Promise<{ uploaded: number; failed: number; skipped: number }> {
  let uploaded = 0;
  let failed = 0;
  let skipped = 0;

  if (!githubAssets || githubAssets.length === 0) {
    return { uploaded, failed, skipped };
  }

  const giteaBaseUrl = config.giteaConfig!.url;
  const giteaAuth = { Authorization: `token ${decryptedConfig.giteaConfig!.token}` };

  // Fetch existing attachments so we only transfer what's missing or changed.
  const existingAssets: Array<{ id: number; name: string; size: number }> = await httpGet(
    `${giteaBaseUrl}/api/v1/repos/${repoOwner}/${repoName}/releases/${giteaReleaseId}/assets`,
    giteaAuth
  )
    .then((r) => (Array.isArray(r?.data) ? r.data : []))
    .catch(() => []);

  const { toUpload, toSkip } = classifyAssetsForReconciliation(
    githubAssets,
    existingAssets
  );
  skipped = toSkip.length;

  const githubByName = new Map(githubAssets.map((a) => [a.name, a]));

  for (const { name, replaceAssetId } of toUpload) {
    const asset = githubByName.get(name)!;
    try {
      // Download from GitHub. fetch strips the Authorization header on the
      // cross-host redirect to GitHub's object storage, so this works for both
      // public and private release assets.
      console.log(
        `[Releases] Downloading asset: ${asset.name} (${asset.size} bytes) for ${tagName}`
      );
      const assetResponse = await fetch(asset.browser_download_url, {
        headers: {
          Accept: "application/octet-stream",
          Authorization: `token ${decryptedConfig.githubConfig!.token}`,
        },
      });

      if (!assetResponse.ok) {
        console.error(
          `[Releases] Failed to download asset ${asset.name}: ${assetResponse.status} ${assetResponse.statusText}`
        );
        failed++;
        continue;
      }

      const assetData = await assetResponse.arrayBuffer();

      // Gitea rejects a duplicate attachment name, so drop a stale/mismatched
      // copy before re-uploading.
      if (replaceAssetId !== null) {
        await httpDelete(
          `${giteaBaseUrl}/api/v1/repos/${repoOwner}/${repoName}/releases/${giteaReleaseId}/assets/${replaceAssetId}`,
          giteaAuth
        ).catch(() => null);
      }

      const formData = new FormData();
      formData.append("attachment", new Blob([assetData]), asset.name);

      const uploadResponse = await fetch(
        `${giteaBaseUrl}/api/v1/repos/${repoOwner}/${repoName}/releases/${giteaReleaseId}/assets?name=${encodeURIComponent(asset.name)}`,
        {
          method: "POST",
          headers: { Authorization: `token ${decryptedConfig.giteaConfig!.token}` },
          body: formData,
        }
      );

      if (uploadResponse.ok) {
        console.log(`[Releases] Successfully uploaded asset: ${asset.name}`);
        uploaded++;
      } else {
        const errorText = await uploadResponse.text();
        console.error(
          `[Releases] Failed to upload asset ${asset.name}: ${uploadResponse.status} ${errorText}`
        );
        failed++;
      }
    } catch (assetError) {
      console.error(
        `[Releases] Error processing asset ${asset.name}: ${
          assetError instanceof Error ? assetError.message : String(assetError)
        }`
      );
      failed++;
    }
  }

  return { uploaded, failed, skipped };
}

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
  const releaseLimit = Math.max(1, Math.floor(config.giteaConfig?.releaseLimit || 10));

  // GitHub API max per page is 100; paginate until we reach the configured limit.
  const releases: Awaited<
    ReturnType<typeof octokit.rest.repos.listReleases>
  >["data"] = [];
  let page = 1;
  const perPage = Math.min(100, releaseLimit);

  while (releases.length < releaseLimit) {
    const response = await octokit.rest.repos.listReleases({
      owner: repository.owner,
      repo: repository.name,
      per_page: perPage,
      page,
    });

    if (response.data.length === 0) {
      break;
    }

    releases.push(...response.data);

    if (response.data.length < perPage) {
      break;
    }

    page++;
  }

  const limitedReleases = releases.slice(0, releaseLimit);

  console.log(
    `[Releases] Found ${limitedReleases.length} releases (limited to latest ${releaseLimit}) to mirror for ${repository.fullName}`
  );

  if (limitedReleases.length === 0) {
    console.log(`[Releases] No releases to mirror for ${repository.fullName}`);
    return;
  }

  let mirroredCount = 0;
  let skippedCount = 0;
  let skippedMissingTagCount = 0;
  let totalAssetsUploaded = 0;
  let totalAssetsFailed = 0;

  // Process releases in their GitHub API order (newest first by default)
  const releasesToProcess = limitedReleases.slice();

  console.log(`[Releases] Processing ${releasesToProcess.length} releases for ${repository.fullName}`);
  releasesToProcess.forEach((rel, idx) => {
    const publishedDate = new Date(rel.published_at || rel.created_at);
    const createdDate = new Date(rel.created_at);
    const dateInfo = rel.published_at !== rel.created_at
      ? `published ${publishedDate.toISOString()} (tag created ${createdDate.toISOString()})`
      : `published ${publishedDate.toISOString()}`;
    console.log(`[Releases] ${idx + 1}. ${rel.tag_name} - ${dateInfo}`);
  });

  for (const release of releasesToProcess) {
    try {
      // Always check if release already exists — reconcile by tag set, not by ordering
      const existingReleasesResponse = await httpGet(
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
          
          await httpPatch(
            `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases/${existingRelease.id}`,
            {
              tag_name: release.tag_name,
              // Omit `target` — the release already exists and is anchored to its tag;
              // re-sending target_commitish risks the same "target not found" 404 (#331).
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

        // Reconcile assets on every sync — backfill any that are missing or changed.
        // The update path used to `continue` here without touching assets, so a
        // release that existed without its full asset set stayed broken forever (#331).
        const assetResult = await reconcileReleaseAssets({
          config,
          decryptedConfig,
          repoOwner,
          repoName,
          giteaReleaseId: existingRelease.id,
          githubAssets: release.assets || [],
          tagName: release.tag_name,
        });
        if (assetResult.uploaded > 0) {
          console.log(
            `[Releases] Backfilled ${assetResult.uploaded} missing/changed asset(s) for existing release ${release.tag_name}`
          );
        }
        totalAssetsUploaded += assetResult.uploaded;
        totalAssetsFailed += assetResult.failed;
        continue;
      }

      // The git tag must already exist in Gitea before we create a release for it.
      // For a mirror, tags are synced from upstream by Gitea's own git mirror, which
      // can lag behind this metadata sync (e.g. a large/slow initial clone). If the
      // tag isn't present yet, skip and let a later sync pick it up — do NOT ask Gitea
      // to create the release against a `target` branch:
      //   - if the target can't be resolved Gitea returns 404 "The target couldn't be
      //     found" and the release is lost (#331),
      //   - if it can, Gitea would create a brand-new tag at the wrong commit.
      const tagExists = await httpGet(
        `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/tags/${encodeURIComponent(release.tag_name)}`,
        { Authorization: `token ${decryptedConfig.giteaConfig.token}` }
      )
        .then(() => true)
        .catch(() => false);

      if (!tagExists) {
        console.warn(
          `[Releases] Tag ${release.tag_name} is not present in Gitea yet — skipping release for now (the git mirror may still be syncing; it will be retried on the next sync)`
        );
        skippedMissingTagCount++;
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
          // Intentionally omit `target`: the tag already exists (verified above), so
          // Gitea attaches the release to it. Sending target_commitish can 404 with
          // "The target couldn't be found" on some Gitea/Forgejo versions (#331).
          title: release.name || release.tag_name,
          body: releaseNote,
          draft: release.draft,
          prerelease: release.prerelease,
        },
        {
          Authorization: `token ${decryptedConfig.giteaConfig.token}`,
        }
      );
      
      // Mirror release assets if they exist (idempotent — see reconcileReleaseAssets)
      if (release.assets && release.assets.length > 0) {
        console.log(`[Releases] Mirroring ${release.assets.length} assets for release ${release.tag_name}`);
        const assetResult = await reconcileReleaseAssets({
          config,
          decryptedConfig,
          repoOwner,
          repoName,
          giteaReleaseId: createReleaseResponse.data.id,
          githubAssets: release.assets,
          tagName: release.tag_name,
        });
        totalAssetsUploaded += assetResult.uploaded;
        totalAssetsFailed += assetResult.failed;
      }

      mirroredCount++;
      const noteInfo = originalReleaseNote ? ` with ${originalReleaseNote.length} character changelog` : " without changelog";
      console.log(`[Releases] Successfully mirrored release: ${release.tag_name}${noteInfo}`);
    } catch (error) {
      console.error(`[Releases] Failed to mirror release ${release.tag_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `✅ Mirrored/Updated ${mirroredCount} releases to Gitea (${skippedCount} already up-to-date, ${skippedMissingTagCount} skipped: tag not synced yet); assets uploaded: ${totalAssetsUploaded}, failed: ${totalAssetsFailed}`
  );

  if (skippedMissingTagCount > 0) {
    console.warn(
      `[Releases] ${skippedMissingTagCount} release(s) skipped because their git tag is not in Gitea yet for ${repository.fullName} — these will be created automatically once the git mirror finishes syncing the tags`
    );
  }

  if (totalAssetsFailed > 0) {
    console.error(
      `[Releases] ⚠️ ${totalAssetsFailed} release asset(s) failed to mirror for ${repository.fullName} — they will be retried on the next sync`
    );
  }

  // Enforce release retention limit by removing the oldest excess releases from Gitea
  try {
    // Paginate to fetch ALL Gitea releases (API max is 100 per page)
    const allGiteaReleases: Array<{ id: number; tag_name: string; created_at: string }> = [];
    let cleanupPage = 1;
    while (true) {
      const pageResponse = await httpGet(
        `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases?per_page=100&page=${cleanupPage}`,
        {
          Authorization: `token ${decryptedConfig.giteaConfig.token}`,
        }
      ).catch(() => null);

      if (!pageResponse?.data || !Array.isArray(pageResponse.data) || pageResponse.data.length === 0) {
        break;
      }

      allGiteaReleases.push(...pageResponse.data);

      if (pageResponse.data.length < 100) {
        break;
      }
      cleanupPage++;
    }

    if (allGiteaReleases.length > releaseLimit) {
      const excessCount = allGiteaReleases.length - releaseLimit;

      // Sort by created_at ascending (oldest first) so we delete the oldest excess
      const sorted = [...allGiteaReleases].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      const toDelete = sorted.slice(0, excessCount);

      console.log(
        `[Releases] Enforcing retention limit (${releaseLimit}): ${allGiteaReleases.length} releases found, removing ${toDelete.length} oldest excess release(s)`
      );

      for (const excess of toDelete) {
        try {
          await httpDelete(
            `${config.giteaConfig.url}/api/v1/repos/${repoOwner}/${repoName}/releases/${excess.id}`,
            {
              Authorization: `token ${decryptedConfig.giteaConfig.token}`,
            }
          );
          console.log(`[Releases] Deleted excess release: ${excess.tag_name}`);
        } catch (deleteError) {
          console.error(
            `[Releases] Failed to delete excess release ${excess.tag_name}: ${
              deleteError instanceof Error ? deleteError.message : String(deleteError)
            }`
          );
        }
      }
    }
  } catch (cleanupError) {
    console.warn(
      `[Releases] Release retention cleanup failed: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`
    );
  }
}

export async function mirrorGitRepoPullRequestsToGitea({
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
  const pullRequests = await octokit.paginate(
    octokit.rest.pulls.list,
    {
      owner,
      repo,
      state: "all",
      per_page: 100,
      sort: "created",
      direction: "asc",
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

  const existingPrIssuesByNumber = new Map<number, any>();
  let prIssuesPage = 1;
  const prIssuesPerPage = 100;
  while (true) {
    const existingIssuesRes = await httpGet(
      `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/issues?state=all&page=${prIssuesPage}&limit=${prIssuesPerPage}`,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );
    const pageIssues = Array.isArray(existingIssuesRes.data)
      ? existingIssuesRes.data
      : [];
    if (!pageIssues.length) break;

    for (const issue of pageIssues) {
      const match = String(issue.title || "").match(/\[PR #(\d+)\]/i);
      if (!match?.[1]) continue;
      const prNumber = Number.parseInt(match[1], 10);
      if (Number.isFinite(prNumber)) {
        existingPrIssuesByNumber.set(prNumber, issue);
      }
    }

    // See note on the existing-issues pre-fetch above: rely on Link
    // header (RFC 5988) rather than short-page heuristic. Gitea caps
    // page size at MAX_RESPONSE_ITEMS (default 50), and some
    // endpoints repeat data on out-of-bound pages instead of [].
    const linkHeader = existingIssuesRes.headers.get("link") || "";
    if (!/\brel="next"/.test(linkHeader)) break;
    prIssuesPage += 1;
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

        let existingPrIssue = existingPrIssuesByNumber.get(pr.number);
        // Defensive recheck (see same pattern in mirrorGitRepoIssuesToGitea):
        // a previous attempt may have committed the PR-issue row and
        // then thrown on the addLabel/repository-counter update. The
        // pre-fetched map doesn't know about it, so without this check
        // processWithRetry would create a duplicate every retry.
        if (!existingPrIssue) {
          try {
            const recheck = await httpGet(
              `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues?state=all&type=issues&q=${encodeURIComponent(`[PR #${pr.number}]`)}`,
              {
                Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
              }
            );
            const candidates = Array.isArray(recheck.data) ? recheck.data : [];
            const hit = candidates.find((c: any) => {
              const m = String(c.title || "").match(/\[PR #(\d+)\]/i);
              return m && Number.parseInt(m[1], 10) === pr.number;
            });
            if (hit) {
              existingPrIssue = hit;
              existingPrIssuesByNumber.set(pr.number, hit);
              console.log(
                `[Pull Requests] Recovered orphan from prior failed attempt for PR #${pr.number}; switching to PATCH`
              );
            }
          } catch (_recheckErr) {
            // Best-effort; fall through to create.
          }
        }
        if (existingPrIssue) {
          await httpPatch(
            `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${existingPrIssue.number}`,
            {
              title: issueData.title,
              body: issueData.body,
              state: issueData.closed ? "closed" : "open",
              labels: issueData.labels,
            },
            {
              Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
            }
          );
        } else {
          console.log(`[Pull Requests] Creating enriched issue for PR #${pr.number}: ${pr.title}`);
          const createdPrIssue = await httpPost(
            `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues`,
            issueData,
            {
              Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
            }
          );
          existingPrIssuesByNumber.set(pr.number, createdPrIssue.data);

          // Verify and explicitly close if the PR issue should be closed but wasn't
          const prShouldBeClosed = pr.state === "closed" || pr.merged_at !== null;
          const prIsActuallyClosed = createdPrIssue.data.state === "closed";

          if (prShouldBeClosed && !prIsActuallyClosed) {
            try {
              await httpPatch(
                `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${createdPrIssue.data.number}`,
                { state: "closed" },
                {
                  Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
                }
              );
            } catch (closeError) {
              console.error(
                `[Pull Requests] Failed to close issue for PR #${pr.number}: ${
                  closeError instanceof Error ? closeError.message : String(closeError)
                }`
              );
            }
          }
        }

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
          let existingPrIssue = existingPrIssuesByNumber.get(pr.number);
          // Defensive recheck — same pattern as the enriched create
          // branch above. Without this, the basic-info fallback would
          // dup on retry-after-deadlock just like the enriched path.
          if (!existingPrIssue) {
            try {
              const recheck = await httpGet(
                `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues?state=all&type=issues&q=${encodeURIComponent(`[PR #${pr.number}]`)}`,
                {
                  Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
                }
              );
              const candidates = Array.isArray(recheck.data) ? recheck.data : [];
              const hit = candidates.find((c: any) => {
                const m = String(c.title || "").match(/\[PR #(\d+)\]/i);
                return m && Number.parseInt(m[1], 10) === pr.number;
              });
              if (hit) {
                existingPrIssue = hit;
                existingPrIssuesByNumber.set(pr.number, hit);
                console.log(
                  `[Pull Requests] Recovered orphan from prior failed attempt for PR #${pr.number} (basic fallback); switching to PATCH`
                );
              }
            } catch (_recheckErr) {
              // Best-effort; fall through to create.
            }
          }
          if (existingPrIssue) {
            await httpPatch(
              `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${existingPrIssue.number}`,
              {
                title: basicIssueData.title,
                body: basicIssueData.body,
                state: basicIssueData.closed ? "closed" : "open",
                labels: basicIssueData.labels,
              },
              {
                Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
              }
            );
          } else {
            const createdBasicPrIssue = await httpPost(
              `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues`,
              basicIssueData,
              {
                Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
              }
            );
            existingPrIssuesByNumber.set(pr.number, createdBasicPrIssue.data);

            // Verify and explicitly close if needed
            const basicPrShouldBeClosed = pr.state === "closed" || pr.merged_at !== null;
            const basicPrIsActuallyClosed = createdBasicPrIssue.data.state === "closed";

            if (basicPrShouldBeClosed && !basicPrIsActuallyClosed) {
              try {
                await httpPatch(
                  `${config.giteaConfig!.url}/api/v1/repos/${giteaOwner}/${repoName}/issues/${createdBasicPrIssue.data.number}`,
                  { state: "closed" },
                  {
                    Authorization: `token ${decryptedConfig.giteaConfig!.token}`,
                  }
                );
              } catch (closeError) {
                console.error(
                  `[Pull Requests] Failed to close basic issue for PR #${pr.number}: ${
                    closeError instanceof Error ? closeError.message : String(closeError)
                  }`
                );
              }
            }
          }

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

  console.log(`✅ Mirrored ${successCount}/${pullRequests.length} pull requests to Gitea as enriched issues (${failedCount} failed)`);
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

  // Get existing labels from Gitea. Paginate because Gitea caps
  // response size at `[api].MAX_RESPONSE_ITEMS` (default 50), so a
  // single unpaginated GET only sees the first 50 labels. Once a repo
  // crosses that threshold every label past it would be re-POSTed as a
  // duplicate on every sync.
  //
  // Pagination signal: prefer Link header (RFC 5988) when present, but
  // Gitea's /labels and /milestones endpoints do NOT emit Link headers
  // — they only emit `X-Total-Count`. Without the fallback, a strict
  // Link-only check terminated after page 1 and re-POSTed every label
  // past index 50 on every sync. (Repro found during the milestone
  // dedup fix: 9 unique milestones leaked past page 1 on a 74-row
  // /milestones response.)
  const existingLabels = new Set<string>();
  const labelsPerPage = 50;
  let labelsPage = 1;
  let labelsFetched = 0;
  while (true) {
    const giteaLabelsRes = await httpGet(
      `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/labels?page=${labelsPage}&limit=${labelsPerPage}`,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );
    const pageLabels = Array.isArray(giteaLabelsRes.data) ? giteaLabelsRes.data : [];
    if (!pageLabels.length) break;
    for (const lbl of pageLabels) existingLabels.add(lbl.name);
    labelsFetched += pageLabels.length;

    const linkHeader = giteaLabelsRes.headers.get("link") || "";
    if (/\brel="next"/.test(linkHeader)) {
      labelsPage += 1;
      continue;
    }
    // No Link header (or no rel=next). Fall back to X-Total-Count.
    const totalStr = giteaLabelsRes.headers.get("x-total-count");
    const total = totalStr ? Number.parseInt(totalStr, 10) : NaN;
    if (Number.isFinite(total) && labelsFetched < total) {
      labelsPage += 1;
      continue;
    }
    break;
  }

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
        // Track locally so a duplicate in `labels` (shouldn't happen,
        // but defensive) doesn't trigger a second POST in the same run.
        existingLabels.add(label.name);
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

  // Get existing milestones from Gitea. Two correctness requirements:
  //   1. `state=all` — Gitea's /milestones endpoint defaults to OPEN
  //      only, so without this every CLOSED GitHub milestone is
  //      misclassified as missing and re-POSTed on every sync. This
  //      was the root cause of the 11k+ duplicate-closed-milestone
  //      blowup observed in production.
  //   2. Pagination via Link header (RFC 5988) — Gitea caps response
  //      size at `[api].MAX_RESPONSE_ITEMS` (default 50), so any repo
  //      with more than ~50 milestones in a given state silently
  //      truncates without it. Same Gitea-side cap that bit the
  //      issues / PRs pre-fetch in commit b76073b.
  // Pagination signal: prefer Link header (RFC 5988) when present, but
  // Gitea's /milestones endpoint does NOT emit a Link header — it only
  // emits `X-Total-Count`. A strict Link-only check terminates after
  // page 1 and re-POSTs every milestone past index 50 on every sync.
  // (Repro: post-fix deploy on Subnet-Calculator leaked 9 unique
  // milestones past page 1 of a 74-row /milestones response.)
  const existingMilestones = new Set<string>();
  const milestonesPerPage = 50;
  let milestonesPage = 1;
  let milestonesFetched = 0;
  while (true) {
    const giteaMilestonesRes = await httpGet(
      `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${repoName}/milestones?state=all&page=${milestonesPage}&limit=${milestonesPerPage}`,
      {
        Authorization: `token ${decryptedConfig.giteaConfig.token}`,
      }
    );
    const pageMilestones = Array.isArray(giteaMilestonesRes.data)
      ? giteaMilestonesRes.data
      : [];
    if (!pageMilestones.length) break;
    for (const ms of pageMilestones) existingMilestones.add(ms.title);
    milestonesFetched += pageMilestones.length;

    const linkHeader = giteaMilestonesRes.headers.get("link") || "";
    if (/\brel="next"/.test(linkHeader)) {
      milestonesPage += 1;
      continue;
    }
    const totalStr = giteaMilestonesRes.headers.get("x-total-count");
    const total = totalStr ? Number.parseInt(totalStr, 10) : NaN;
    if (Number.isFinite(total) && milestonesFetched < total) {
      milestonesPage += 1;
      continue;
    }
    break;
  }

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
        // Track locally so a duplicate within `milestones` (shouldn't
        // happen, but defensive) doesn't trigger a second POST.
        existingMilestones.add(milestone.title);
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
