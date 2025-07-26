/**
 * Enhanced handler for starred repositories with improved error handling
 */

import type { Config, Repository } from "./db/schema";
import { Octokit } from "@octokit/rest";
import { processWithRetry } from "./utils/concurrency";
import { 
  getOrCreateGiteaOrgEnhanced, 
  getGiteaRepoInfo,
  handleExistingNonMirrorRepo,
  createOrganizationsSequentially 
} from "./gitea-enhanced";
import { mirrorGithubRepoToGitea } from "./gitea";
import { getMirrorStrategyConfig } from "./utils/mirror-strategies";
import { createMirrorJob } from "./helpers";

/**
 * Process starred repositories with enhanced error handling
 */
export async function processStarredRepositories({
  config,
  repositories,
  octokit,
}: {
  config: Config;
  repositories: Repository[];
  octokit: Octokit;
}): Promise<void> {
  if (!config.userId) {
    throw new Error("User ID is required");
  }

  const strategyConfig = getMirrorStrategyConfig();
  
  console.log(`Processing ${repositories.length} starred repositories`);
  console.log(`Using strategy config:`, strategyConfig);

  // Step 1: Pre-create organizations to avoid race conditions
  if (strategyConfig.sequentialOrgCreation) {
    await preCreateOrganizations({ config, repositories });
  }

  // Step 2: Process repositories with enhanced error handling
  await processWithRetry(
    repositories,
    async (repository) => {
      try {
        await processStarredRepository({
          config,
          repository,
          octokit,
          strategyConfig,
        });
        return repository;
      } catch (error) {
        console.error(`Failed to process starred repository ${repository.name}:`, error);
        throw error;
      }
    },
    {
      concurrencyLimit: strategyConfig.repoBatchSize,
      maxRetries: 2,
      retryDelay: 2000,
      onProgress: (completed, total, result) => {
        const percentComplete = Math.round((completed / total) * 100);
        if (result) {
          console.log(
            `Processed starred repository "${result.name}" (${completed}/${total}, ${percentComplete}%)`
          );
        }
      },
      onRetry: (repo, error, attempt) => {
        console.log(
          `Retrying starred repository ${repo.name} (attempt ${attempt}): ${error.message}`
        );
      },
    }
  );
}

/**
 * Pre-create all required organizations sequentially
 */
async function preCreateOrganizations({
  config,
  repositories,
}: {
  config: Config;
  repositories: Repository[];
}): Promise<void> {
  // Get unique organization names
  const orgNames = new Set<string>();
  
  // Add starred repos org
  if (config.githubConfig?.starredReposOrg) {
    orgNames.add(config.githubConfig.starredReposOrg);
  } else {
    orgNames.add("starred");
  }

  // Add any other organizations based on mirror strategy
  for (const repo of repositories) {
    if (repo.destinationOrg) {
      orgNames.add(repo.destinationOrg);
    }
  }

  console.log(`Pre-creating ${orgNames.size} organizations sequentially`);

  // Create organizations sequentially
  await createOrganizationsSequentially({
    config,
    orgNames: Array.from(orgNames),
  });
}

/**
 * Process a single starred repository with enhanced error handling
 */
async function processStarredRepository({
  config,
  repository,
  octokit,
  strategyConfig,
}: {
  config: Config;
  repository: Repository;
  octokit: Octokit;
  strategyConfig: ReturnType<typeof getMirrorStrategyConfig>;
}): Promise<void> {
  const starredOrg = config.githubConfig?.starredReposOrg || "starred";
  
  // Check if repository exists in Gitea
  const existingRepo = await getGiteaRepoInfo({
    config,
    owner: starredOrg,
    repoName: repository.name,
  });

  if (existingRepo) {
    if (existingRepo.mirror) {
      console.log(`Starred repository ${repository.name} already exists as a mirror`);
      
      // Update database status
      const { db, repositories: reposTable } = await import("./db");
      const { eq } = await import("drizzle-orm");
      const { repoStatusEnum } = await import("@/types/Repository");
      
      await db
        .update(reposTable)
        .set({
          status: repoStatusEnum.parse("mirrored"),
          updatedAt: new Date(),
          lastMirrored: new Date(),
          errorMessage: null,
          mirroredLocation: `${starredOrg}/${repository.name}`,
        })
        .where(eq(reposTable.id, repository.id!));
      
      return;
    } else {
      // Repository exists but is not a mirror
      console.warn(`Starred repository ${repository.name} exists but is not a mirror`);
      
      await handleExistingNonMirrorRepo({
        config,
        repository,
        repoInfo: existingRepo,
        strategy: strategyConfig.nonMirrorStrategy,
      });
      
      // If we deleted it, continue to create the mirror
      if (strategyConfig.nonMirrorStrategy !== "delete") {
        return; // Skip if we're not deleting
      }
    }
  }

  // Create the mirror
  try {
    await mirrorGithubRepoToGitea({
      octokit,
      repository,
      config,
    });
  } catch (error) {
    // Enhanced error handling for specific scenarios
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      
      if (errorMessage.includes("already exists")) {
        // Handle race condition where repo was created by another process
        console.log(`Repository ${repository.name} was created by another process`);
        
        // Check if it's a mirror now
        const recheck = await getGiteaRepoInfo({
          config,
          owner: starredOrg,
          repoName: repository.name,
        });
        
        if (recheck && recheck.mirror) {
          // It's now a mirror, update database
          const { db, repositories: reposTable } = await import("./db");
          const { eq } = await import("drizzle-orm");
          const { repoStatusEnum } = await import("@/types/Repository");
          
          await db
            .update(reposTable)
            .set({
              status: repoStatusEnum.parse("mirrored"),
              updatedAt: new Date(),
              lastMirrored: new Date(),
              errorMessage: null,
              mirroredLocation: `${starredOrg}/${repository.name}`,
            })
            .where(eq(reposTable.id, repository.id!));
          
          return;
        }
      }
    }
    
    throw error;
  }
}

/**
 * Sync all starred repositories
 */
export async function syncStarredRepositories({
  config,
  repositories,
}: {
  config: Config;
  repositories: Repository[];
}): Promise<void> {
  const strategyConfig = getMirrorStrategyConfig();
  
  console.log(`Syncing ${repositories.length} starred repositories`);

  await processWithRetry(
    repositories,
    async (repository) => {
      try {
        // Import syncGiteaRepo
        const { syncGiteaRepo } = await import("./gitea");
        
        await syncGiteaRepo({
          config,
          repository,
        });
        
        return repository;
      } catch (error) {
        if (error instanceof Error && error.message.includes("not a mirror")) {
          console.warn(`Repository ${repository.name} is not a mirror, handling...`);
          
          const starredOrg = config.githubConfig?.starredReposOrg || "starred";
          const repoInfo = await getGiteaRepoInfo({
            config,
            owner: starredOrg,
            repoName: repository.name,
          });
          
          if (repoInfo) {
            await handleExistingNonMirrorRepo({
              config,
              repository,
              repoInfo,
              strategy: strategyConfig.nonMirrorStrategy,
            });
          }
        }
        
        throw error;
      }
    },
    {
      concurrencyLimit: strategyConfig.repoBatchSize,
      maxRetries: 1,
      retryDelay: 1000,
      onProgress: (completed, total) => {
        const percentComplete = Math.round((completed / total) * 100);
        console.log(`Sync progress: ${completed}/${total} (${percentComplete}%)`);
      },
    }
  );
}