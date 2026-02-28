/**
 * Force-push detection and protection for mirrored repositories.
 *
 * This module provides:
 * 1. Detection of force-pushes by comparing branch SHAs between GitHub and Gitea
 * 2. Detection of branch deletions (branch exists in Gitea but not in GitHub)
 * 3. Creation of backup branches in Gitea (`_<branch>_backup_<timestamp>`)
 * 4. Blocking sync when destructive changes are detected (pending manual approval)
 *
 * Both force-pushes and branch deletions are considered "destructive changes"
 * because they can cause commits to become unreachable and effectively lost.
 *
 * The backup-branch approach is far more storage-efficient than full bundle
 * backups because it only adds a lightweight ref inside the existing Gitea repo
 * rather than duplicating the entire repository.  This makes it the ideal
 * default for large mirrors (100+ GiB).
 */

import type { Config, ForcePushAction } from "@/types/config";
import type { Repository } from "@/lib/db/schema";
import { httpGet, httpPost, HttpError } from "@/lib/http-client";
import { decryptConfigTokens } from "@/lib/utils/config-encryption";
import { createMirrorJob } from "@/lib/helpers";
import { db, repositories } from "@/lib/db";
import { eq } from "drizzle-orm";
import { repoStatusEnum } from "@/types/Repository";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BranchRef {
  name: string;
  sha: string;
}

export interface ForcePushDetectionResult {
  /**
   * true when at least one branch was force-pushed OR deleted upstream.
   * This is the single flag callers should check to decide whether
   * protective action is needed.
   */
  destructiveChangesDetected: boolean;

  /** @deprecated Use `destructiveChangesDetected` instead. Kept for compat. */
  forcePushDetected: boolean;

  /** branches whose SHA differs between Gitea and GitHub (potential force-push / rebase) */
  affectedBranches: Array<{
    branch: string;
    giteaSha: string;
    githubSha: string;
  }>;

  /** branches that are in sync (same SHA on both sides) */
  normalBranches: string[];

  /** branches that exist on GitHub but not yet on Gitea (new upstream branches) */
  newBranches: string[];

  /**
   * Branches that exist on Gitea but NOT on GitHub — they were deleted
   * upstream and the mirror sync will remove them from Gitea, losing any
   * commits unique to those branches.
   */
  deletedBranches: string[];
}

export interface BackupBranchResult {
  created: Array<{ branch: string; backupBranch: string }>;
  failed: Array<{ branch: string; error: string }>;
}

// ─── Configuration helpers ───────────────────────────────────────────────────

/**
 * Returns the configured force-push action for the given config.
 *
 * Defaults to `"backup-branch"` when the field is absent.  This is the
 * recommended default because it is storage-efficient (just a ref, no data
 * duplication) and non-disruptive (sync still proceeds).  Users who want the
 * old behavior can explicitly set `"allow"`.
 */
export function getForcePushAction(config: Partial<Config>): ForcePushAction {
  return config.giteaConfig?.forcePushAction ?? "backup-branch";
}

// ─── Gitea branch helpers ────────────────────────────────────────────────────

/**
 * List all branches of a Gitea repository via the API.
 * Pages through results to cover repos with many branches.
 */
export async function listGiteaBranches({
  giteaUrl,
  token,
  owner,
  repo,
}: {
  giteaUrl: string;
  token: string;
  owner: string;
  repo: string;
}): Promise<BranchRef[]> {
  const branches: BranchRef[] = [];
  let page = 1;
  const limit = 50;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${giteaUrl}/api/v1/repos/${owner}/${repo}/branches?page=${page}&limit=${limit}`;
    try {
      const resp = await httpGet<
        Array<{ name: string; commit: { id: string } }>
      >(url, { Authorization: `token ${token}` });

      if (!resp.data || resp.data.length === 0) break;

      for (const b of resp.data) {
        branches.push({ name: b.name, sha: b.commit.id });
      }

      if (resp.data.length < limit) break;
      page++;
    } catch (err) {
      // If the repo doesn't exist yet there are no branches to compare
      if (err instanceof HttpError && err.status === 404) break;
      throw err;
    }
  }

  return branches;
}

/**
 * List all branches of a GitHub repository via the REST API (no auth needed
 * for public repos, but we use the token when available for higher rate
 * limits and private repo access).
 */
export async function listGitHubBranches({
  githubToken,
  owner,
  repo,
}: {
  githubToken?: string;
  owner: string;
  repo: string;
}): Promise<BranchRef[]> {
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit(githubToken ? { auth: githubToken } : undefined);

  const branches: BranchRef[] = [];
  let page = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await octokit.repos.listBranches({
      owner,
      repo,
      per_page: 100,
      page,
    });

    if (!data || data.length === 0) break;

    for (const b of data) {
      branches.push({ name: b.name, sha: b.commit.sha });
    }

    if (data.length < 100) break;
    page++;
  }

  return branches;
}

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Compares branches between GitHub (source) and Gitea (destination) to detect
 * destructive changes: force-pushes AND branch deletions.
 *
 * A **force-push** is detected when both sides have the same branch but the
 * SHAs differ.  We cannot cheaply verify ancestry without cloning, so any SHA
 * mismatch on an existing branch is treated as a *potential* force-push.
 *
 * A **branch deletion** is detected when a branch exists in Gitea but not in
 * GitHub — the mirror sync will remove it, losing any commits unique to that
 * branch.
 *
 * This is intentionally conservative: a normal fast-forward push will also
 * show up as "affected" until Gitea syncs.  The caller should invoke this
 * *before* triggering the mirror-sync so that the Gitea side still has the
 * old SHAs.
 *
 * Note: backup branches (names starting with `_` and containing `_backup_`)
 * are excluded from deletion detection to avoid flagging our own backups as
 * "deleted upstream".
 */
export function detectForcePushes(
  giteaBranches: BranchRef[],
  githubBranches: BranchRef[],
): ForcePushDetectionResult {
  const giteaMap = new Map(giteaBranches.map((b) => [b.name, b.sha]));
  const githubMap = new Map(githubBranches.map((b) => [b.name, b.sha]));

  const affectedBranches: ForcePushDetectionResult["affectedBranches"] = [];
  const normalBranches: string[] = [];
  const newBranches: string[] = [];
  const deletedBranches: string[] = [];

  // Walk GitHub branches
  for (const [name, githubSha] of githubMap) {
    const giteaSha = giteaMap.get(name);
    if (giteaSha === undefined) {
      // Branch exists on GitHub but not (yet) on Gitea → new branch
      newBranches.push(name);
    } else if (giteaSha === githubSha) {
      // Same SHA → already in sync
      normalBranches.push(name);
    } else {
      // SHA differs → potential force-push
      affectedBranches.push({ branch: name, giteaSha, githubSha });
    }
  }

  // Branches only on Gitea → they were deleted upstream.
  // Skip backup branches we created ourselves (they start with `_` and
  // contain `_backup_`) so we don't endlessly back up our own backups.
  const BACKUP_BRANCH_RE = /^_.*_backup_/;
  for (const [name] of giteaMap) {
    if (!githubMap.has(name) && !BACKUP_BRANCH_RE.test(name)) {
      deletedBranches.push(name);
    }
  }

  const forcePushDetected = affectedBranches.length > 0;
  const destructiveChangesDetected =
    forcePushDetected || deletedBranches.length > 0;

  return {
    destructiveChangesDetected,
    forcePushDetected,
    affectedBranches,
    normalBranches,
    newBranches,
    deletedBranches,
  };
}

// ─── Backup branch creation ─────────────────────────────────────────────────

function buildTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Creates lightweight backup branches in the Gitea repository for every
 * branch that is about to be overwritten or deleted.
 *
 * The naming convention is `_<branch>_backup_<ISO-timestamp>`, e.g.
 * `_main_backup_2026-02-25T18-34-22-123Z`.
 *
 * This is extremely space-efficient because the backup is just a new ref
 * pointing at the *existing* commit objects inside the Gitea repo – no data
 * is duplicated.
 */
export async function createBackupBranches({
  giteaUrl,
  token,
  owner,
  repo,
  branches,
}: {
  giteaUrl: string;
  token: string;
  owner: string;
  repo: string;
  /** Branches to back up, with the SHA that should be preserved. */
  branches: Array<{ branch: string; sha: string }>;
}): Promise<BackupBranchResult> {
  const ts = buildTimestamp();
  const created: BackupBranchResult["created"] = [];
  const failed: BackupBranchResult["failed"] = [];

  for (const { branch, sha } of branches) {
    const backupBranch = `_${branch}_backup_${ts}`;
    const url = `${giteaUrl}/api/v1/repos/${owner}/${repo}/branches`;

    try {
      await httpPost(
        url,
        {
          new_branch_name: backupBranch,
          old_branch_name: branch,
        },
        { Authorization: `token ${token}` },
      );
      created.push({ branch, backupBranch });
    } catch (err) {
      // If the branch create fails (e.g. branch already exists or source
      // branch name doesn't work), try with the SHA directly using the
      // git refs API.  This is especially important for deleted branches
      // where old_branch_name may no longer be valid.
      try {
        const refUrl = `${giteaUrl}/api/v1/repos/${owner}/${repo}/git/refs`;
        await httpPost(
          refUrl,
          { ref: `refs/heads/${backupBranch}`, sha },
          { Authorization: `token ${token}` },
        );
        created.push({ branch, backupBranch });
      } catch (innerErr) {
        const msg =
          innerErr instanceof Error ? innerErr.message : String(innerErr);
        failed.push({ branch, error: msg });
      }
    }
  }

  return { created, failed };
}

// ─── High-level integration ──────────────────────────────────────────────────

/**
 * Builds a human-readable summary of what destructive changes were detected.
 */
function summarizeDestructiveChanges(
  detection: ForcePushDetectionResult,
): string {
  const parts: string[] = [];

  if (detection.affectedBranches.length > 0) {
    const names = detection.affectedBranches.map((b) => b.branch).join(", ");
    parts.push(`Force-push detected on: ${names}`);
  }

  if (detection.deletedBranches.length > 0) {
    const names = detection.deletedBranches.join(", ");
    parts.push(`Branch(es) deleted upstream: ${names}`);
  }

  return parts.join(". ");
}

/**
 * Runs force-push AND branch-deletion detection and applies the configured
 * protection action *before* the mirror-sync is triggered.
 *
 * Returns `{ shouldSync: boolean }`.  When `false`, the caller must NOT
 * proceed with the Gitea mirror-sync API call.
 */
export async function handleForcePushProtection({
  config,
  repository,
  giteaOwner,
  githubOwner,
  githubRepo,
}: {
  config: Partial<Config>;
  repository: Repository;
  giteaOwner: string;
  githubOwner: string;
  githubRepo: string;
}): Promise<{
  shouldSync: boolean;
  detection: ForcePushDetectionResult | null;
}> {
  const action = getForcePushAction(config);

  // "allow" means no detection at all – just sync
  if (action === "allow") {
    return { shouldSync: true, detection: null };
  }

  if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
    console.warn(
      "[ForcePush] Gitea config incomplete, skipping force-push detection",
    );
    return { shouldSync: true, detection: null };
  }

  const decrypted = decryptConfigTokens(config as Config);
  const giteaToken = decrypted.giteaConfig?.token;
  if (!giteaToken) {
    console.warn("[ForcePush] Could not decrypt Gitea token");
    return { shouldSync: true, detection: null };
  }

  // Decrypt GitHub token for private repo access
  const githubToken = decrypted.githubConfig?.token || undefined;

  // ── Fetch branch lists ────────────────────────────────────────────────
  let giteaBranches: BranchRef[];
  let githubBranches: BranchRef[];

  try {
    giteaBranches = await listGiteaBranches({
      giteaUrl: config.giteaConfig.url,
      token: giteaToken,
      owner: giteaOwner,
      repo: repository.name,
    });
  } catch (err) {
    console.warn(
      `[ForcePush] Failed to list Gitea branches for ${giteaOwner}/${repository.name}: ${err}`,
    );
    // If we cannot read Gitea branches, we can't detect anything – allow sync
    return { shouldSync: true, detection: null };
  }

  // If Gitea has no branches yet (first mirror), nothing to protect
  if (giteaBranches.length === 0) {
    return { shouldSync: true, detection: null };
  }

  try {
    githubBranches = await listGitHubBranches({
      githubToken,
      owner: githubOwner,
      repo: githubRepo,
    });
  } catch (err) {
    console.warn(
      `[ForcePush] Failed to list GitHub branches for ${githubOwner}/${githubRepo}: ${err}`,
    );
    return { shouldSync: true, detection: null };
  }

  // ── Detect ────────────────────────────────────────────────────────────
  const detection = detectForcePushes(giteaBranches, githubBranches);

  if (!detection.destructiveChangesDetected) {
    console.log(
      `[ForcePush] No destructive changes detected for ${repository.name}, sync will proceed`,
    );
    return { shouldSync: true, detection };
  }

  const summary = summarizeDestructiveChanges(detection);
  console.log(
    `[ForcePush] Destructive changes for ${repository.name}: ${summary}`,
  );

  // ── Collect branches that need backup ─────────────────────────────────
  // Both force-pushed branches (preserve old SHA) AND deleted branches
  // (preserve current Gitea SHA before the mirror sync removes them).
  const giteaMap = new Map(giteaBranches.map((b) => [b.name, b.sha]));

  const branchesToBackup: Array<{ branch: string; sha: string }> = [];

  for (const b of detection.affectedBranches) {
    branchesToBackup.push({ branch: b.branch, sha: b.giteaSha });
  }

  for (const name of detection.deletedBranches) {
    const sha = giteaMap.get(name);
    if (sha) {
      branchesToBackup.push({ branch: name, sha });
    }
  }

  // ── Apply action ──────────────────────────────────────────────────────
  if (action === "backup-branch") {
    const backupResult = await createBackupBranches({
      giteaUrl: config.giteaConfig.url,
      token: giteaToken,
      owner: giteaOwner,
      repo: repository.name,
      branches: branchesToBackup,
    });

    // Log the backup results
    for (const { branch, backupBranch } of backupResult.created) {
      console.log(
        `[ForcePush] Created backup branch ${backupBranch} for ${branch} in ${giteaOwner}/${repository.name}`,
      );
    }
    for (const { branch, error } of backupResult.failed) {
      console.error(
        `[ForcePush] Failed to create backup branch for ${branch}: ${error}`,
      );
    }

    // Record activity
    await createMirrorJob({
      userId: config.userId!,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Backup branches created for ${repository.name}`,
      details: [
        summary,
        `Created ${backupResult.created.length} backup branch(es).`,
        backupResult.failed.length > 0
          ? `Failed to create ${backupResult.failed.length} backup branch(es): ${backupResult.failed.map((f) => `${f.branch}: ${f.error}`).join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      status: "syncing",
    });

    // Allow the sync to proceed – we already preserved the old refs
    return { shouldSync: true, detection };
  }

  if (action === "block") {
    // Mark the repo as pending-approval and do NOT sync
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("pending-approval"),
        updatedAt: new Date(),
        errorMessage: `${summary}. Sync blocked – manual approval required.`,
      })
      .where(eq(repositories.id, repository.id!));

    await createMirrorJob({
      userId: config.userId!,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Sync blocked for ${repository.name} – destructive changes detected`,
      details: `${summary}. The sync has been blocked. Approve or dismiss from the dashboard to continue.`,
      status: "failed",
    });

    console.log(
      `[ForcePush] Sync blocked for ${repository.name} – repo set to pending-approval`,
    );

    return { shouldSync: false, detection };
  }

  // Unknown action – fall through to allow
  return { shouldSync: true, detection };
}
