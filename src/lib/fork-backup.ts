/**
 * Fork-based backup for force-push protection in mirrored repositories.
 *
 * This module provides a workaround for Gitea's read-only mirror restriction:
 * 1. When a force-push is detected in a mirror repo (which is read-only)
 * 2. Fork the repo to a designated "force-push-backup" organization
 * 3. Create backup branches in the fork (which is a regular repo, not a mirror)
 * 4. This preserves the pre-force-push state while allowing the original mirror to sync
 *
 * The fork approach is superior to alternatives because:
 * - Gitea uses copy-on-write for forks (very space efficient)
 * - Forks are regular repos and allow branch creation
 * - No need to delete/recreate mirrors (which breaks sync history)
 * - Backup branches are stored in the fork, separate from the mirror
 */

import { httpPost, httpGet, httpDelete, HttpError } from "@/lib/http-client";
import { decryptConfigTokens } from "@/lib/utils/config-encryption";
import type { Config } from "@/types/config";

interface GiteaRepoInfo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  mirror: boolean;
  clone_url: string;
  html_url: string;
  private: boolean;
  description?: string;
}

interface ForkResult {
  success: boolean;
  forkOwner: string;
  forkRepo: string;
  forkUrl: string;
  alreadyExisted: boolean;
  error?: string;
}

interface BackupBranchResult {
  created: Array<{ branch: string; backupBranch: string }>;
  failed: Array<{ branch: string; error: string }>;
}

const BACKUP_ORG_DEFAULT = "force-push-backup";
const BACKUP_BRANCH_PREFIX = "_backup_";

function buildTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Get or create the backup organization for force-push backups.
 * This organization will hold all forked repositories.
 */
export async function getOrCreateBackupOrg({
  giteaUrl,
  token,
  orgName = BACKUP_ORG_DEFAULT,
  visibility = "private",
}: {
  giteaUrl: string;
  token: string;
  orgName?: string;
  visibility?: "public" | "private" | "limited";
}): Promise<{ id: number; name: string }> {
  // First, check if the organization already exists
  try {
    const orgResponse = await httpGet<{ id: number; username: string }>(
      `${giteaUrl}/api/v1/orgs/${orgName}`,
      { Authorization: `token ${token}` },
    );
    console.log(`[ForkBackup] Backup organization ${orgName} exists with ID: ${orgResponse.data.id}`);
    return { id: orgResponse.data.id, name: orgName };
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) {
      throw error; // Unexpected error
    }
    // Organization doesn't exist, create it
  }

  // Create the organization
  console.log(`[ForkBackup] Creating backup organization: ${orgName}`);
  try {
    const createResponse = await httpPost<{ id: number; username: string }>(
      `${giteaUrl}/api/v1/orgs`,
      {
        username: orgName,
        full_name: "Force Push Backup Repositories",
        description: "Forked repositories for force-push backup protection",
        visibility: visibility,
      },
      { Authorization: `token ${token}` },
    );
    console.log(`[ForkBackup] Created backup organization ${orgName} with ID: ${createResponse.data.id}`);
    return { id: createResponse.data.id, name: orgName };
  } catch (error) {
    // Handle "already exists" error - the org might exist but was not found earlier
    if (error instanceof HttpError) {
      const errorLower = (error.response || "").toLowerCase();
      if (error.status === 422 &&
          (errorLower.includes("already exists") || errorLower.includes("user already exists"))) {
        console.log(`[ForkBackup] Organization ${orgName} already exists (concurrent creation)`);
        // Try to get the org again
        try {
          const orgResponse = await httpGet<{ id: number; username: string }>(
            `${giteaUrl}/api/v1/orgs/${orgName}`,
            { Authorization: `token ${token}` },
          );
          return { id: orgResponse.data.id, name: orgName };
        } catch {
          // Fall through to throw original error
        }
      }
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create backup organization ${orgName}: ${errorMessage}`);
  }
}
      }
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create backup organization ${orgName}: ${errorMessage}`);
  }
}

/**
 * Build unique fork name to avoid collisions when multiple owners have repos with same name.
 * Pattern: {originalOwner}_{repoName}
 */
function buildForkName(sourceOwner: string, sourceRepo: string): string {
  return `${sourceOwner}_${sourceRepo}`;
}

/**
 * Check if a fork already exists in the backup organization.
 */
async function getExistingFork({
  giteaUrl,
  token,
  backupOrg,
  repoName,
  originalOwner,
}: {
  giteaUrl: string;
  token: string;
  backupOrg: string;
  repoName: string;
  originalOwner: string;
}): Promise<GiteaRepoInfo | null> {
  // Use unique fork name to avoid collisions
  const forkName = buildForkName(originalOwner, repoName);

  try {
    const response = await httpGet<GiteaRepoInfo>(
      `${giteaUrl}/api/v1/repos/${backupOrg}/${forkName}`,
      { Authorization: `token ${token}` },
    );

    // Verify this is actually a fork of the expected repo
    const repoInfo = response.data;
    if (repoInfo && !repoInfo.mirror) {
      // Check if it's a fork by looking at the parent (if available) or just assume it's ours
      // Gitea API doesn't always expose parent info, so we'll use naming convention
      console.log(`[ForkBackup] Found existing fork: ${backupOrg}/${forkName}`);
      return repoInfo;
    }
    return null;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return null; // Fork doesn't exist
    }
    throw error;
  }
}

/**
 * Fork a repository to the backup organization.
 *
 * This creates a fork of the mirror repository. Since Gitea uses copy-on-write
 * for forks, this is extremely space-efficient - no data is actually duplicated
 * until the forked repo is modified.
 */
export async function forkToBackupOrg({
  giteaUrl,
  token,
  sourceOwner,
  sourceRepo,
  backupOrg,
}: {
  giteaUrl: string;
  token: string;
  sourceOwner: string;
  sourceRepo: string;
  backupOrg: string;
}): Promise<ForkResult> {
  // Use unique fork name to avoid collisions: {owner}_{repo}
  const forkName = buildForkName(sourceOwner, sourceRepo);

  // Check if fork already exists
  const existingFork = await getExistingFork({
    giteaUrl,
    token,
    backupOrg,
    repoName: sourceRepo,
    originalOwner: sourceOwner,
  });

  if (existingFork) {
    console.log(`[ForkBackup] Fork already exists: ${backupOrg}/${forkName}`);
    return {
      success: true,
      forkOwner: backupOrg,
      forkRepo: forkName,
      forkUrl: existingFork.html_url,
      alreadyExisted: true,
    };
  }

  // Create the fork with unique name
  console.log(`[ForkBackup] Forking ${sourceOwner}/${sourceRepo} to ${backupOrg}/${forkName}...`);
  try {
    const forkResponse = await httpPost<GiteaRepoInfo>(
      `${giteaUrl}/api/v1/repos/${sourceOwner}/${sourceRepo}/forks`,
      {
        organization: backupOrg,
        name: forkName,
      },
      { Authorization: `token ${token}` },
    );

    const forkInfo = forkResponse.data;
    console.log(`[ForkBackup] Successfully forked to ${forkInfo.full_name}`);

    return {
      success: true,
      forkOwner: backupOrg,
      forkRepo: forkName,
      forkUrl: forkInfo.html_url,
      alreadyExisted: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ForkBackup] Failed to fork ${sourceOwner}/${sourceRepo}: ${errorMessage}`);

    // Check for specific error types
    if (error instanceof HttpError) {
      if (error.status === 403) {
        return {
          success: false,
          forkOwner: backupOrg,
          forkRepo: forkName,
          forkUrl: "",
          alreadyExisted: false,
          error: `Permission denied: ${errorMessage}. Ensure the Gitea token has permission to fork repositories.`,
        };
      }
      if (error.status === 404) {
        return {
          success: false,
          forkOwner: backupOrg,
          forkRepo: forkName,
          forkUrl: "",
          alreadyExisted: false,
          error: `Source repository not found: ${sourceOwner}/${sourceRepo}`,
        };
      }
    }

    return {
      success: false,
      forkOwner: backupOrg,
      forkRepo: forkName,
      forkUrl: "",
      alreadyExisted: false,
      error: errorMessage,
    };
  }
}

/**
 * Create backup branches in the forked repository.
 *
 * Unlike the original mirror, the fork is a regular repository and allows
 * branch creation via API.
 */
async function createBackupBranchesInFork({
  giteaUrl,
  token,
  forkOwner,
  forkRepo,
  branches,
}: {
  giteaUrl: string;
  token: string;
  forkOwner: string;
  forkRepo: string;
  branches: Array<{ branch: string; sha: string }>;
}): Promise<BackupBranchResult> {
  const ts = buildTimestamp();
  const created: BackupBranchResult["created"] = [];
  const failed: BackupBranchResult["failed"] = [];

  for (const { branch, sha } of branches) {
    const backupBranchName = `${BACKUP_BRANCH_PREFIX}${branch}_${ts}`;
    const url = `${giteaUrl}/api/v1/repos/${forkOwner}/${forkRepo}/branches`;

    console.log(`[ForkBackup] Creating backup branch ${backupBranchName} from ${branch} (sha: ${sha.substring(0, 8)})`);

    try {
      // Try creating branch from old branch name first
      await httpPost(
        url,
        {
          new_branch_name: backupBranchName,
          old_branch_name: branch,
        },
        { Authorization: `token ${token}` },
      );
      created.push({ branch, backupBranch: backupBranchName });
      console.log(`[ForkBackup] Created backup branch ${backupBranchName}`);
    } catch (err) {
      // If branch creation fails (e.g., branch doesn't exist in fork), try git refs API
      try {
        const refUrl = `${giteaUrl}/api/v1/repos/${forkOwner}/${forkRepo}/git/refs`;
        await httpPost(
          refUrl,
          { ref: `refs/heads/${backupBranchName}`, sha },
          { Authorization: `token ${token}` },
        );
        created.push({ branch, backupBranch: backupBranchName });
        console.log(`[ForkBackup] Created backup branch ${backupBranchName} via git refs API`);
      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        console.error(`[ForkBackup] Failed to create backup branch ${backupBranchName}: ${msg}`);
        failed.push({ branch, error: msg });
      }
    }
  }

  return { created, failed };
}

/**
 * Main entry point for fork-based backup.
 *
 * This function:
 * 1. Ensures the backup organization exists
 * 2. Forks the source repo to the backup org (if not already forked)
 * 3. Creates backup branches in the fork for the specified SHAs
 *
 * Returns the results including the fork URL for user reference.
 */
export async function createForkBasedBackup({
  config,
  sourceOwner,
  sourceRepo,
  branches,
  backupOrgName,
}: {
  config: Partial<Config>;
  sourceOwner: string;
  sourceRepo: string;
  branches: Array<{ branch: string; sha: string }>;
  backupOrgName?: string;
}): Promise<{
  success: boolean;
  forkUrl?: string;
  created: Array<{ branch: string; backupBranch: string }>;
  failed: Array<{ branch: string; error: string }>;
  error?: string;
}> {
  if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
    return {
      success: false,
      created: [],
      failed: branches.map(b => ({ branch: b.branch, error: "Gitea config incomplete" })),
      error: "Gitea configuration incomplete",
    };
  }

  const decrypted = decryptConfigTokens(config as Config);
  const token = decrypted.giteaConfig?.token;
  if (!token) {
    return {
      success: false,
      created: [],
      failed: branches.map(b => ({ branch: b.branch, error: "Failed to decrypt Gitea token" })),
      error: "Failed to decrypt Gitea token",
    };
  }

  const giteaUrl = config.giteaConfig.url;
  const backupOrg = backupOrgName || BACKUP_ORG_DEFAULT;

  try {
    // Step 1: Ensure backup organization exists
    console.log(`[ForkBackup] Ensuring backup organization exists: ${backupOrg}`);
    await getOrCreateBackupOrg({
      giteaUrl,
      token,
      orgName: backupOrg,
      visibility: "private", // Backup org should be private
    });

    // Step 2: Fork the repository
    console.log(`[ForkBackup] Forking ${sourceOwner}/${sourceRepo} to ${backupOrg}`);
    const forkResult = await forkToBackupOrg({
      giteaUrl,
      token,
      sourceOwner,
      sourceRepo,
      backupOrg,
    });

    if (!forkResult.success) {
      return {
        success: false,
        created: [],
        failed: branches.map(b => ({ branch: b.branch, error: forkResult.error || "Fork failed" })),
        error: forkResult.error || "Failed to fork repository",
      };
    }

    // Step 3: Create backup branches in the fork
    console.log(`[ForkBackup] Creating ${branches.length} backup branches in fork`);
    const backupResult = await createBackupBranchesInFork({
      giteaUrl,
      token,
      forkOwner: forkResult.forkOwner,
      forkRepo: forkResult.forkRepo,
      branches,
    });

    return {
      success: backupResult.failed.length === 0,
      forkUrl: forkResult.forkUrl,
      created: backupResult.created,
      failed: backupResult.failed,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ForkBackup] Unexpected error: ${errorMessage}`);
    return {
      success: false,
      created: [],
      failed: branches.map(b => ({ branch: b.branch, error: errorMessage })),
      error: errorMessage,
    };
  }
}

/**
 * Clean up old forks in the backup organization.
 *
 * This can be used to remove forks that are no longer needed.
 * Use with caution - this permanently deletes the forks and their backup branches.
 */
export async function cleanupOldForks({
  config,
  backupOrgName,
  olderThanDays,
}: {
  config: Partial<Config>;
  backupOrgName?: string;
  olderThanDays?: number;
}): Promise<{
  deleted: string[];
  failed: Array<{ repo: string; error: string }>;
}> {
  if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
    return { deleted: [], failed: [] };
  }

  const decrypted = decryptConfigTokens(config as Config);
  const token = decrypted.giteaConfig?.token;
  if (!token) {
    return { deleted: [], failed: [] };
  }

  const giteaUrl = config.giteaConfig.url;
  const backupOrg = backupOrgName || BACKUP_ORG_DEFAULT;

  const deleted: string[] = [];
  const failed: Array<{ repo: string; error: string }> = [];

  try {
    // List all repositories in the backup organization
    const repos: GiteaRepoInfo[] = [];
    let page = 1;
    const limit = 50;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await httpGet<GiteaRepoInfo[]>(
        `${giteaUrl}/api/v1/orgs/${backupOrg}/repos?page=${page}&limit=${limit}`,
        { Authorization: `token ${token}` },
      );

      if (!response.data || response.data.length === 0) break;
      repos.push(...response.data);
      if (response.data.length < limit) break;
      page++;
    }

    console.log(`[ForkBackup] Found ${repos.length} repositories in backup org ${backupOrg}`);

    for (const repo of repos) {
      // Check if the repo should be deleted based on age
      if (olderThanDays) {
        // Note: We'd need to fetch repo details to get updated_at
        // For now, skip age-based deletion
        continue;
      }

      try {
        await httpDelete(
          `${giteaUrl}/api/v1/repos/${backupOrg}/${repo.name}`,
          { Authorization: `token ${token}` },
        );
        deleted.push(repo.name);
        console.log(`[ForkBackup] Deleted fork: ${backupOrg}/${repo.name}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failed.push({ repo: repo.name, error: msg });
        console.error(`[ForkBackup] Failed to delete ${backupOrg}/${repo.name}: ${msg}`);
      }
    }
  } catch (error) {
    console.error(`[ForkBackup] Error listing repos in backup org: ${error}`);
  }

  return { deleted, failed };
}
