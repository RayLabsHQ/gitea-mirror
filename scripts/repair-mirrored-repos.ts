#!/usr/bin/env bun

/**
 * Script to repair repositories that exist in Gitea but have incorrect status in the database
 * This fixes the issue where repositories show as "imported" but are actually mirrored in Gitea
 * 
 * Usage: bun scripts/repair-mirrored-repos.ts [--dry-run] [--repo-name=<name>]
 */

import { db, repositories, configs } from "@/lib/db";
import { eq, and, or } from "drizzle-orm";
import { createMirrorJob } from "@/lib/helpers";
import { repoStatusEnum } from "@/types/Repository";

const isDryRun = process.argv.includes("--dry-run");
const specificRepo = process.argv.find(arg => arg.startsWith("--repo-name="))?.split("=")[1];
const isStartupMode = process.argv.includes("--startup");
const requestTimeoutMs = parsePositiveInteger(process.env.GITEA_REPAIR_REQUEST_TIMEOUT_MS, 15000);
const progressInterval = parsePositiveInteger(process.env.GITEA_REPAIR_PROGRESS_INTERVAL, 100);

type GiteaLookupResult = {
  exists: boolean;
  details: any | null;
  timedOut: boolean;
  error: string | null;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "TimeoutError" || error.name === "AbortError";
}

async function getRepoDetailsFromGitea(config: any, owner: string, repoName: string): Promise<GiteaLookupResult> {
  try {
    if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
      return {
        exists: false,
        details: null,
        timedOut: false,
        error: "Missing Gitea URL or token in config",
      };
    }

    const response = await fetch(
      `${config.giteaConfig.url}/api/v1/repos/${owner}/${repoName}`,
      {
        headers: {
          Authorization: `token ${config.giteaConfig.token}`,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      }
    );

    if (response.ok) {
      return {
        exists: true,
        details: await response.json(),
        timedOut: false,
        error: null,
      };
    }

    if (response.status === 404) {
      return {
        exists: false,
        details: null,
        timedOut: false,
        error: null,
      };
    }

    return {
      exists: false,
      details: null,
      timedOut: false,
      error: `Gitea API returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      exists: false,
      details: null,
      timedOut: isTimeoutError(error),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function repairMirroredRepositories() {
  if (!isStartupMode) {
    console.log("🔧 Repairing mirrored repositories database status");
    console.log("=" .repeat(60));

    if (isDryRun) {
      console.log("🔍 DRY RUN MODE - No changes will be made");
      console.log("");
    }

    if (specificRepo) {
      console.log(`🎯 Targeting specific repository: ${specificRepo}`);
      console.log("");
    }
  }

  try {
    // Find repositories that might need repair
    const whereConditions = specificRepo
      ? and(
          or(
            eq(repositories.status, "imported"),
            eq(repositories.status, "failed")
          ),
          eq(repositories.name, specificRepo)
        )
      : or(
          eq(repositories.status, "imported"),
          eq(repositories.status, "failed")
        );

    const repos = await db
      .select()
      .from(repositories)
      .where(whereConditions);

    const totalRepos = repos.length;

    if (repos.length === 0) {
      if (!isStartupMode) {
        console.log("✅ No repositories found that need repair");
      }
      return;
    }

    if (!isStartupMode) {
      console.log(`📋 Found ${repos.length} repositories to check:`);
      console.log("");
    } else {
      console.log(`Checking ${totalRepos} repositories for status inconsistencies...`);
      console.log(`Request timeout: ${requestTimeoutMs}ms | Progress interval: every ${progressInterval} repositories`);
    }

    const startedAt = Date.now();
    const configCache = new Map<string, any>();
    let checkedCount = 0;
    let repairedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let timeoutCount = 0;
    let giteaErrorCount = 0;
    let giteaErrorSamples = 0;
    let startupSkipWarningCount = 0;

    for (const repo of repos) {
      checkedCount++;

      if (!isStartupMode) {
        console.log(`🔍 Checking repository: ${repo.name}`);
        console.log(`   Current status: ${repo.status}`);
        console.log(`   Mirrored location: ${repo.mirroredLocation || "Not set"}`);
      }

      try {
        // Get user configuration
        const configKey = String(repo.configId);
        let userConfig = configCache.get(configKey);

        if (!userConfig) {
          const config = await db
            .select()
            .from(configs)
            .where(eq(configs.id, repo.configId))
            .limit(1);

          if (config.length === 0) {
            if (!isStartupMode) {
              console.log(`   ❌ No configuration found for repository`);
            }
            errorCount++;
            continue;
          }

          userConfig = config[0];
          configCache.set(configKey, userConfig);
        }

        if (!userConfig) {
          if (!isStartupMode) {
            console.log(`   ❌ No configuration found for repository`);
          }
          errorCount++;
          continue;
        }

        const giteaUsername = userConfig.giteaConfig?.defaultOwner;

        if (!giteaUsername) {
          if (!isStartupMode) {
            console.log(`   ❌ No Gitea username in configuration`);
          }
          errorCount++;
          continue;
        }

        // Check if repository exists in Gitea (try both user and organization)
        let existsInGitea = false;
        let actualOwner = giteaUsername;
        let giteaRepoDetails = null;
        let repoRequestTimedOut = false;
        let repoRequestErrored = false;

        // First check user location
        const userLookup = await getRepoDetailsFromGitea(userConfig, giteaUsername, repo.name);
        existsInGitea = userLookup.exists;
        giteaRepoDetails = userLookup.details;

        if (userLookup.timedOut) {
          timeoutCount++;
          repoRequestTimedOut = true;
        } else if (userLookup.error) {
          giteaErrorCount++;
          repoRequestErrored = true;
          if (!isStartupMode || giteaErrorSamples < 3) {
            console.log(`   ⚠️  Gitea lookup issue for ${giteaUsername}/${repo.name}: ${userLookup.error}`);
            giteaErrorSamples++;
          }
        }

        // If not found in user location and repo has organization, check organization
        if (!existsInGitea && repo.organization) {
          const orgLookup = await getRepoDetailsFromGitea(userConfig, repo.organization, repo.name);
          existsInGitea = orgLookup.exists;
          if (existsInGitea) {
            actualOwner = repo.organization;
            giteaRepoDetails = orgLookup.details;
          }

          if (orgLookup.timedOut) {
            timeoutCount++;
            repoRequestTimedOut = true;
          } else if (orgLookup.error) {
            giteaErrorCount++;
            repoRequestErrored = true;
            if (!isStartupMode || giteaErrorSamples < 3) {
              console.log(`   ⚠️  Gitea lookup issue for ${repo.organization}/${repo.name}: ${orgLookup.error}`);
              giteaErrorSamples++;
            }
          }
        }

        if (!existsInGitea) {
          if (!isStartupMode) {
            console.log(`   ⏭️  Repository not found in Gitea - skipping`);
          } else if (repoRequestTimedOut || repoRequestErrored) {
            if (startupSkipWarningCount < 3) {
              console.log(`   ⚠️  Skipping ${repo.name}; Gitea was slow/unreachable during lookup`);
              startupSkipWarningCount++;
              if (startupSkipWarningCount === 3) {
                console.log(`   ℹ️  Additional slow/unreachable lookup warnings suppressed; progress logs will continue`);
              }
            }
          }
          skippedCount++;
          continue;
        }

        if (!isStartupMode) {
          console.log(`   ✅ Repository found in Gitea at: ${actualOwner}/${repo.name}`);

          if (giteaRepoDetails) {
            console.log(`   📊 Gitea details:`);
            console.log(`      Mirror: ${giteaRepoDetails.mirror}`);
            console.log(`      Created: ${new Date(giteaRepoDetails.created_at).toISOString()}`);
            console.log(`      Updated: ${new Date(giteaRepoDetails.updated_at).toISOString()}`);
            if (giteaRepoDetails.mirror_updated) {
              console.log(`      Mirror Updated: ${new Date(giteaRepoDetails.mirror_updated).toISOString()}`);
            }
          }
        } else if (repairedCount === 0) {
          // In startup mode, only log the first repair to indicate activity
          console.log(`Repairing repository status inconsistencies...`);
        }

        if (!isDryRun) {
          // Update repository status in database
          const mirrorUpdated = giteaRepoDetails?.mirror_updated 
            ? new Date(giteaRepoDetails.mirror_updated)
            : new Date();

          await db
            .update(repositories)
            .set({
              status: repoStatusEnum.parse("mirrored"),
              updatedAt: new Date(),
              lastMirrored: mirrorUpdated,
              errorMessage: null,
              mirroredLocation: `${actualOwner}/${repo.name}`,
            })
            .where(eq(repositories.id, repo.id!));

          // Create a mirror job log entry
          await createMirrorJob({
            userId: userConfig.userId || "",
            repositoryId: repo.id,
            repositoryName: repo.name,
            message: `Repository status repaired - found existing mirror in Gitea`,
            details: `Repository ${repo.name} was found to already exist in Gitea at ${actualOwner}/${repo.name} and database status was updated from ${repo.status} to mirrored.`,
            status: "mirrored",
          });

          if (!isStartupMode) {
            console.log(`   🔧 Repaired: Updated status to 'mirrored'`);
          }
        } else {
          if (!isStartupMode) {
            console.log(`   🔧 Would repair: Update status from '${repo.status}' to 'mirrored'`);
          }
        }

        repairedCount++;

      } catch (error) {
        if (!isStartupMode) {
          console.log(`   ❌ Error processing repository: ${error instanceof Error ? error.message : String(error)}`);
        }
        errorCount++;
      }

      if (!isStartupMode) {
        console.log("");
      } else if (checkedCount % progressInterval === 0 || checkedCount === totalRepos) {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        console.log(
          `Repair progress: ${checkedCount}/${totalRepos} checked | repaired=${repairedCount}, skipped=${skippedCount}, errors=${errorCount}, timeouts=${timeoutCount} | elapsed=${elapsedSeconds}s`
        );
      }
    }

    if (isStartupMode) {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      console.log(
        `Repository repair summary: checked=${checkedCount}, repaired=${repairedCount}, skipped=${skippedCount}, errors=${errorCount}, timeouts=${timeoutCount}, elapsed=${elapsedSeconds}s`
      );
      if (repairedCount > 0) {
        console.log(`Repaired ${repairedCount} repository status inconsistencies`);
      }
      if (errorCount > 0) {
        console.log(`Warning: ${errorCount} repositories had errors during repair`);
      }
      if (timeoutCount > 0) {
        console.log(
          `Warning: ${timeoutCount} Gitea API requests timed out. Increase GITEA_REPAIR_REQUEST_TIMEOUT_MS if your Gitea instance is under heavy load.`
        );
      }
      if (giteaErrorCount > 0) {
        console.log(`Warning: ${giteaErrorCount} Gitea API requests failed with non-timeout errors.`);
      }
    } else {
      console.log("📊 Repair Summary:");
      console.log(`   Checked: ${checkedCount}`);
      console.log(`   Repaired: ${repairedCount}`);
      console.log(`   Skipped: ${skippedCount}`);
      console.log(`   Errors: ${errorCount}`);
      console.log(`   Timeouts: ${timeoutCount}`);
      if (giteaErrorCount > 0) {
        console.log(`   Gitea API Errors: ${giteaErrorCount}`);
      }

      if (isDryRun && repairedCount > 0) {
        console.log("");
        console.log("💡 To apply these changes, run the script without --dry-run");
      }
    }

  } catch (error) {
    console.error("❌ Error during repair process:", error);
  }
}

// Run the repair
repairMirroredRepositories().then(() => {
  console.log("Repair process complete.");
  process.exit(0);
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
