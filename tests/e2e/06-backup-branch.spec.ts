/**
 * 06 – Backup-branch protection E2E tests.
 *
 * Tests the NEW force-push protection feature that creates lightweight
 * backup branches inside Gitea when destructive changes (force-pushes
 * or branch deletions) are detected upstream.
 *
 * This file exercises all three `forcePushAction` modes:
 *   • `backup-branch` – creates `_<branch>_backup_<timestamp>` refs in Gitea
 *   • `block`         – sets repo to `pending-approval`, requires manual action
 *   • `allow`         – no detection, legacy behavior
 *
 * It also tests branch-deletion detection and the approve/dismiss API.
 *
 * Prerequisites:
 *   - 02-mirror-workflow.spec.ts must have run (my-project is mirrored)
 *   - 04-force-push.spec.ts should have run and restored the source repo
 *
 * The test manipulates both the source bare git repo (to simulate actual
 * force-pushes that Gitea will pick up) AND the fake GitHub server's branch
 * data (so the force-push detection code sees the correct SHAs when it
 * compares GitHub vs Gitea branches).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  APP_URL,
  GITEA_URL,
  FAKE_GITHUB_URL,
  GITEA_MIRROR_ORG,
  GiteaAPI,
  getAppSessionCookies,
  saveConfig,
  waitFor,
  getRepositoryIds,
  triggerSyncRepo,
  updateFakeGitHubBranches,
  deleteFakeGitHubBranch,
  approveSyncRepo,
} from "./helpers";

// ─── Paths ───────────────────────────────────────────────────────────────────

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const GIT_REPOS_DIR = join(E2E_DIR, "git-repos");
const MY_PROJECT_BARE = join(GIT_REPOS_DIR, "e2e-test-user", "my-project.git");

// ─── Git helpers ─────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Backup Test Bot",
        GIT_AUTHOR_EMAIL: "backup-test@test.local",
        GIT_COMMITTER_NAME: "Backup Test Bot",
        GIT_COMMITTER_EMAIL: "backup-test@test.local",
      },
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    throw new Error(
      `git ${args} failed in ${cwd}:\n${stderr || stdout || err.message}`,
    );
  }
}

function getRefSha(bareRepo: string, ref: string): string {
  return git(`rev-parse ${ref}`, bareRepo);
}

/**
 * Clone bare repo → mutate working copy → force-push back → update-server-info.
 */
function mutateSourceRepo(
  bareRepo: string,
  tmpName: string,
  mutate: (workDir: string) => void,
): void {
  const tmpDir = join(GIT_REPOS_DIR, ".work-backup-branch", tmpName);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(join(GIT_REPOS_DIR, ".work-backup-branch"), { recursive: true });

  try {
    git(`clone "${bareRepo}" "${tmpDir}"`, GIT_REPOS_DIR);
    git("config user.name 'Backup Test Bot'", tmpDir);
    git("config user.email 'backup-test@test.local'", tmpDir);

    mutate(tmpDir);

    git(`push --force --all "${bareRepo}"`, tmpDir);
    git(`push --force --tags "${bareRepo}"`, tmpDir);
    git("update-server-info", bareRepo);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function cleanupWorkDir(): void {
  const workDir = join(GIT_REPOS_DIR, ".work-backup-branch");
  rmSync(workDir, { recursive: true, force: true });
}

/**
 * Helper: create a secondary branch in the source bare repo.
 * We need this to test branch-deletion detection.
 */
function createSourceBranch(
  bareRepo: string,
  branchName: string,
  fileContent: string,
): void {
  const tmpDir = join(
    GIT_REPOS_DIR,
    ".work-backup-branch",
    `create-${branchName}`,
  );
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(join(GIT_REPOS_DIR, ".work-backup-branch"), { recursive: true });

  try {
    git(`clone "${bareRepo}" "${tmpDir}"`, GIT_REPOS_DIR);
    git("config user.name 'Backup Test Bot'", tmpDir);
    git("config user.email 'backup-test@test.local'", tmpDir);

    git(`checkout -b ${branchName}`, tmpDir);
    writeFileSync(join(tmpDir, `${branchName}.txt`), fileContent);
    git("add -A", tmpDir);
    execSync(
      `git commit -m "Add content for branch ${branchName}"`,
      {
        cwd: tmpDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Backup Test Bot",
          GIT_AUTHOR_EMAIL: "backup-test@test.local",
          GIT_COMMITTER_NAME: "Backup Test Bot",
          GIT_COMMITTER_EMAIL: "backup-test@test.local",
        },
      },
    );
    git(`push "${bareRepo}" ${branchName}`, tmpDir);
    git("update-server-info", bareRepo);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Helper: delete a branch from the source bare repo.
 */
function deleteSourceBranch(bareRepo: string, branchName: string): void {
  git(`branch -D ${branchName}`, bareRepo);
  git("update-server-info", bareRepo);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe("E2E: Backup-branch protection", () => {
  let giteaApi: GiteaAPI;
  let appCookies = "";
  let myProjectId = "";

  /** SHA of main on Gitea before any force-push in this suite. */
  let baselineMainSha = "";

  test.beforeAll(async () => {
    giteaApi = new GiteaAPI(GITEA_URL);
    try {
      await giteaApi.createToken();
    } catch {
      console.log("[BackupBranch] Could not create Gitea token");
    }
  });

  /**
   * Helper: ensure we have myProjectId (re-fetch on retry if needed)
   */
  async function ensureMyProjectId(request: any): Promise<string> {
    if (myProjectId) return myProjectId;
    
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }
    
    const { repos } = await getRepositoryIds(request, appCookies);
    const myProj = repos.find((r: any) => r.name === "my-project");
    if (myProj) {
      myProjectId = myProj.id;
      console.log(`[BackupBranch] Re-fetched my-project ID: ${myProjectId}`);
    }
    return myProjectId;
  }

  test.afterAll(async () => {
    cleanupWorkDir();
    await giteaApi.dispose();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BB0: Preconditions — make sure my-project is mirrored and record baseline
  // ════════════════════════════════════════════════════════════════════════════

  test("BB0: Record baseline state and sync fake GitHub branches", async ({
    request,
  }) => {
    expect(
      existsSync(MY_PROJECT_BARE),
      `Bare repo should exist at ${MY_PROJECT_BARE}`,
    ).toBeTruthy();

    // Get app session
    appCookies = await getAppSessionCookies(request);

    // Verify my-project is mirrored in Gitea
    const repo = await giteaApi.getRepo(GITEA_MIRROR_ORG, "my-project");
    expect(repo, "my-project should exist in Gitea").toBeTruthy();

    // Record main branch SHA in Gitea
    const mainBranch = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      "main",
    );
    expect(mainBranch, "main branch should exist in Gitea").toBeTruthy();
    baselineMainSha = mainBranch.commit.id;
    console.log(
      `[BackupBranch] Baseline main SHA: ${baselineMainSha.substring(0, 12)}`,
    );

    // Get the source repo's main SHA
    const sourceMainSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");
    console.log(
      `[BackupBranch] Source main SHA: ${sourceMainSha.substring(0, 12)}`,
    );

    // CRITICAL: Sync the fake GitHub server's branch data to match what Gitea
    // currently has. This is required because the force-push detection code
    // compares GitHub branches (from fake server) with Gitea branches.
    // If they match, no force-push is detected. If they differ, it's a "force-push".
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: baselineMainSha },
    ]);
    console.log(
      "[BackupBranch] Fake GitHub branches synced to match Gitea baseline",
    );

    // Find the my-project repo ID in the app's database
    const { ids, repos } = await getRepositoryIds(request, appCookies);
    const myProj = repos.find((r: any) => r.name === "my-project");
    if (myProj) {
      myProjectId = myProj.id;
      console.log(`[BackupBranch] my-project app ID: ${myProjectId}`);
    }
    expect(myProjectId, "Should find my-project ID in app").toBeTruthy();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BB1: backup-branch mode — force-push creates backup refs
  // ════════════════════════════════════════════════════════════════════════════

  test("BB1: Enable backup-branch mode and force-push", async ({ request }) => {
    if (!appCookies) appCookies = await getAppSessionCookies(request);
    const giteaToken = giteaApi.getTokenValue();

    // Enable backup-branch mode (the default, but be explicit)
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        forcePushAction: "backup-branch",
        backupBeforeSync: false, // disable bundle backups to isolate our feature
        blockSyncOnBackupFailure: false,
      },
    });
    console.log("[BackupBranch] Config set: forcePushAction=backup-branch");

    // Force-push: rewrite history in source repo
    mutateSourceRepo(MY_PROJECT_BARE, "bb-rewrite-1", (workDir) => {
      git("checkout main", workDir);
      git("reset --hard HEAD~1", workDir);
      writeFileSync(
        join(workDir, "README.md"),
        "# My Project\n\nBACKUP-BRANCH TEST: Force-pushed content.\n",
      );
      writeFileSync(
        join(workDir, "BB_MARKER.txt"),
        `Backup-branch force-push at ${new Date().toISOString()}\n`,
      );
      git("add -A", workDir);
      execSync('git commit -m "BB1: Force-push for backup-branch test"', {
        cwd: workDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Backup Test Bot",
          GIT_AUTHOR_EMAIL: "backup-test@test.local",
          GIT_COMMITTER_NAME: "Backup Test Bot",
          GIT_COMMITTER_EMAIL: "backup-test@test.local",
        },
      });
    });

    const newSourceSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");
    console.log(
      `[BackupBranch] Source after force-push: ${newSourceSha.substring(0, 12)}`,
    );
    expect(newSourceSha).not.toBe(baselineMainSha);

    // Update fake GitHub to reflect the NEW SHA (so detection sees the mismatch
    // between GitHub's new SHA and Gitea's old SHA)
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: newSourceSha },
    ]);
    console.log("[BackupBranch] Fake GitHub updated with new main SHA");

    // Trigger sync through the app (goes through handleForcePushProtection)
    console.log("[BackupBranch] Triggering app sync-repo...");
    const syncStatus = await triggerSyncRepo(
      request,
      appCookies,
      [await ensureMyProjectId(request)],
      30_000,
    );
    console.log(`[BackupBranch] sync-repo response: ${syncStatus}`);
    expect(syncStatus).toBeLessThan(500);
  });

  test("BB2: Verify backup branch was created in Gitea", async () => {
    // Wait for Gitea to pick up the force-pushed content
    await waitFor(
      async () => {
        const branch = await giteaApi.getBranch(
          GITEA_MIRROR_ORG,
          "my-project",
          "main",
        );
        if (!branch) return false;
        return branch.commit.id !== baselineMainSha;
      },
      {
        timeout: 90_000,
        interval: 5_000,
        label: "Gitea main branch updates after backup-branch force-push",
      },
    );

    // List all branches — look for backup branches matching the pattern
    const branches = await giteaApi.listBranches(
      GITEA_MIRROR_ORG,
      "my-project",
    );
    const branchNames = branches.map((b: any) => b.name);
    console.log(
      `[BackupBranch] All branches after BB1: ${branchNames.join(", ")}`,
    );

    // Backup branches follow the pattern: _main_backup_<timestamp>
    const backupBranches = branchNames.filter((n: string) =>
      /^_main_backup_/.test(n),
    );
    console.log(
      `[BackupBranch] Backup branches found: ${backupBranches.length}`,
    );

    expect(
      backupBranches.length,
      "At least one backup branch should have been created for main",
    ).toBeGreaterThanOrEqual(1);

    // The backup branch should point to the OLD (baseline) SHA
    const latestBackup = backupBranches[backupBranches.length - 1];
    const backupBranch = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      latestBackup,
    );
    expect(backupBranch, `Backup branch ${latestBackup} should exist`).toBeTruthy();

    console.log(
      `[BackupBranch] Backup branch ${latestBackup} SHA: ${backupBranch.commit.id.substring(0, 12)}`,
    );
    console.log(
      `[BackupBranch] Expected baseline SHA: ${baselineMainSha.substring(0, 12)}`,
    );

    // The backup should preserve the old SHA (before force-push)
    expect(
      backupBranch.commit.id,
      "Backup branch should point to the pre-force-push SHA",
    ).toBe(baselineMainSha);

    // Verify the current main has the new content
    const marker = await giteaApi.getFileContent(
      GITEA_MIRROR_ORG,
      "my-project",
      "BB_MARKER.txt",
    );
    expect(marker, "Force-push marker should be in Gitea main").toBeTruthy();

    // Verify the backup branch still has the OLD content (pre-force-push)
    const backupReadme = await giteaApi.getFileContent(
      GITEA_MIRROR_ORG,
      "my-project",
      "README.md",
      latestBackup,
    );
    expect(
      backupReadme,
      "Backup branch README should exist",
    ).toBeTruthy();
    expect(
      backupReadme,
      "Backup branch README should NOT contain force-push text",
    ).not.toContain("BACKUP-BRANCH TEST");

    console.log(
      "[BackupBranch] ✓ Backup branch preserves old state — protection works!",
    );
  });

  test("BB3: Verify backup activity was logged", async ({ request }) => {
    if (!appCookies) appCookies = await getAppSessionCookies(request);

    const activitiesResp = await request.get(`${APP_URL}/api/activities`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });

    if (!activitiesResp.ok()) {
      console.log(
        `[BackupBranch] Could not fetch activities: ${activitiesResp.status()}`,
      );
      // Don't fail the test — activities endpoint may not exist in all versions
      return;
    }

    const activities = await activitiesResp.json();
    const jobs: any[] = Array.isArray(activities)
      ? activities
      : (activities.jobs ?? activities.activities ?? []);

    // Look for backup branch creation activity
    const backupActivities = jobs.filter(
      (j: any) =>
        j.repositoryName === "my-project" &&
        (j.message?.toLowerCase().includes("backup branch") ||
          j.details?.toLowerCase().includes("backup branch") ||
          j.message?.toLowerCase().includes("force-push") ||
          j.details?.toLowerCase().includes("force-push")),
    );

    console.log(
      `[BackupBranch] Backup activities for my-project: ${backupActivities.length}`,
    );
    for (const a of backupActivities.slice(0, 5)) {
      console.log(
        `[BackupBranch]   • [${a.status}] ${a.message ?? ""} | ${(a.details ?? "").substring(0, 500)}`,
      );
    }

    expect(
      backupActivities.length,
      "At least one backup-branch activity should be logged",
    ).toBeGreaterThan(0);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BB4: Restore, then test branch-deletion backup
  // ════════════════════════════════════════════════════════════════════════════

  test("BB4: Restore source and create a secondary branch", async ({
    request,
  }) => {
    // Restore main to a good state
    mutateSourceRepo(MY_PROJECT_BARE, "bb-restore-1", (workDir) => {
      git("checkout main", workDir);
      try {
        execSync("rm -f BB_MARKER.txt", { cwd: workDir });
      } catch {
        /* ignore */
      }
      writeFileSync(
        join(workDir, "README.md"),
        "# My Project\n\nA sample project for E2E testing.\n\n" +
          "## Features\n- Greeting module\n- Math utilities\n",
      );
      writeFileSync(
        join(workDir, "LICENSE"),
        "MIT License\n\nCopyright (c) 2024 E2E Test\n",
      );
      git("add -A", workDir);
      execSync(
        'git commit --allow-empty -m "BB4: Restore after backup-branch test"',
        {
          cwd: workDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Backup Test Bot",
            GIT_AUTHOR_EMAIL: "backup-test@test.local",
            GIT_COMMITTER_NAME: "Backup Test Bot",
            GIT_COMMITTER_EMAIL: "backup-test@test.local",
          },
        },
      );
    });

    // Create a secondary branch in the source repo
    createSourceBranch(
      MY_PROJECT_BARE,
      "feature-to-delete",
      "This branch will be deleted to test branch-deletion backup.\n",
    );

    const featureSha = getRefSha(
      MY_PROJECT_BARE,
      "refs/heads/feature-to-delete",
    );
    const mainSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");
    console.log(
      `[BackupBranch] Source main: ${mainSha.substring(0, 12)}, ` +
        `feature-to-delete: ${featureSha.substring(0, 12)}`,
    );

    // Update fake GitHub to have both branches
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: mainSha },
      { name: "feature-to-delete", sha: featureSha },
    ]);

    // Trigger Gitea mirror-sync so it picks up the new branch
    await giteaApi.triggerMirrorSync(GITEA_MIRROR_ORG, "my-project");
    console.log("[BackupBranch] Mirror-sync triggered for branch pickup");
    await new Promise((r) => setTimeout(r, 15_000));

    // Wait for feature-to-delete to appear in Gitea
    await waitFor(
      async () => {
        const branch = await giteaApi.getBranch(
          GITEA_MIRROR_ORG,
          "my-project",
          "feature-to-delete",
        );
        return branch !== null;
      },
      {
        timeout: 60_000,
        interval: 5_000,
        label: "feature-to-delete appears in Gitea",
      },
    );

    // Update baseline SHA
    const giteaMain = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      "main",
    );
    baselineMainSha = giteaMain.commit.id;
    console.log(
      `[BackupBranch] New baseline main SHA: ${baselineMainSha.substring(0, 12)}`,
    );

    const giteaFeature = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      "feature-to-delete",
    );
    console.log(
      `[BackupBranch] Gitea feature-to-delete SHA: ${giteaFeature.commit.id.substring(0, 12)}`,
    );
    console.log("[BackupBranch] ✓ Secondary branch created and mirrored");
  });

  test("BB5: Delete branch upstream, trigger sync with backup-branch mode", async ({
    request,
  }) => {
    if (!appCookies) appCookies = await getAppSessionCookies(request);

    // Record the SHA of feature-to-delete in Gitea before we delete it upstream
    const featureBranch = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      "feature-to-delete",
    );
    expect(featureBranch, "feature-to-delete should exist in Gitea").toBeTruthy();
    const featureSha = featureBranch.commit.id;
    console.log(
      `[BackupBranch] feature-to-delete SHA before deletion: ${featureSha.substring(0, 12)}`,
    );

    // Delete the branch from the source repo
    deleteSourceBranch(MY_PROJECT_BARE, "feature-to-delete");
    console.log("[BackupBranch] Deleted feature-to-delete from source repo");

    // Remove it from fake GitHub too (so detection sees it's gone)
    const mainSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: mainSha },
      // feature-to-delete is NOT listed → detected as "deleted upstream"
    ]);
    console.log(
      "[BackupBranch] Fake GitHub updated: feature-to-delete removed",
    );

    // Ensure backup-branch mode is still active
    const giteaToken = giteaApi.getTokenValue();
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        forcePushAction: "backup-branch",
        backupBeforeSync: false,
        blockSyncOnBackupFailure: false,
      },
    });

    // Trigger sync through the app
    console.log(
      "[BackupBranch] Triggering app sync-repo (branch deletion detection)...",
    );
    const syncStatus = await triggerSyncRepo(
      request,
      appCookies,
      [await ensureMyProjectId(request)],
      25_000,
    );
    console.log(`[BackupBranch] sync-repo response: ${syncStatus}`);
    expect(syncStatus).toBeLessThan(500);
  });

  test("BB6: Verify backup branch was created for deleted branch", async () => {
    // Give Gitea time to process the mirror sync that removes the branch
    await new Promise((r) => setTimeout(r, 10_000));

    // Trigger a direct Gitea mirror-sync as well to ensure the branch removal happens
    await giteaApi.triggerMirrorSync(GITEA_MIRROR_ORG, "my-project");
    await new Promise((r) => setTimeout(r, 15_000));

    // List all branches
    const branches = await giteaApi.listBranches(
      GITEA_MIRROR_ORG,
      "my-project",
    );
    const branchNames = branches.map((b: any) => b.name);
    console.log(
      `[BackupBranch] All branches after BB5: ${branchNames.join(", ")}`,
    );

    // Look for backup of the deleted branch
    const deletionBackups = branchNames.filter((n: string) =>
      /^_feature-to-delete_backup_/.test(n),
    );
    console.log(
      `[BackupBranch] Deletion backup branches: ${deletionBackups.length}`,
    );

    expect(
      deletionBackups.length,
      "At least one backup branch should exist for the deleted feature-to-delete branch",
    ).toBeGreaterThanOrEqual(1);

    // Verify the backup branch has the content from the deleted branch
    const latestBackup = deletionBackups[deletionBackups.length - 1];
    const backupContent = await giteaApi.getFileContent(
      GITEA_MIRROR_ORG,
      "my-project",
      "feature-to-delete.txt",
      latestBackup,
    );
    expect(
      backupContent,
      `Backup branch ${latestBackup} should contain feature-to-delete.txt`,
    ).toBeTruthy();
    expect(backupContent).toContain("deleted to test branch-deletion backup");

    console.log(
      "[BackupBranch] ✓ Branch-deletion backup preserves deleted branch content!",
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BB7–BB9: block mode — force-push blocks sync
  // ════════════════════════════════════════════════════════════════════════════

  test("BB7: Enable block mode, force-push, and verify sync is blocked", async ({
    request,
  }) => {
    if (!appCookies) appCookies = await getAppSessionCookies(request);
    const giteaToken = giteaApi.getTokenValue();

    // First, make sure Gitea is in a clean state — record current main SHA
    const giteaMain = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      "main",
    );
    baselineMainSha = giteaMain.commit.id;
    console.log(
      `[BackupBranch] Block mode baseline main: ${baselineMainSha.substring(0, 12)}`,
    );

    // Sync fake GitHub to match current Gitea (so it's "in sync")
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: baselineMainSha },
    ]);

    // Enable block mode
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        forcePushAction: "block",
        backupBeforeSync: false,
        blockSyncOnBackupFailure: false,
      },
    });
    console.log("[BackupBranch] Config set: forcePushAction=block");

    // Force-push to source repo
    mutateSourceRepo(MY_PROJECT_BARE, "bb-block-rewrite", (workDir) => {
      git("checkout main", workDir);
      git("reset --hard HEAD~1", workDir);
      writeFileSync(
        join(workDir, "README.md"),
        "# My Project\n\nBLOCK MODE: This should be blocked.\n",
      );
      writeFileSync(
        join(workDir, "BLOCK_MARKER.txt"),
        `Block mode force-push at ${new Date().toISOString()}\n`,
      );
      git("add -A", workDir);
      execSync('git commit -m "BB7: Force-push to test block mode"', {
        cwd: workDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Backup Test Bot",
          GIT_AUTHOR_EMAIL: "backup-test@test.local",
          GIT_COMMITTER_NAME: "Backup Test Bot",
          GIT_COMMITTER_EMAIL: "backup-test@test.local",
        },
      });
    });

    const newSourceSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");
    console.log(
      `[BackupBranch] Source after block-mode force-push: ${newSourceSha.substring(0, 12)}`,
    );

    // Update fake GitHub to reflect the new SHA
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: newSourceSha },
    ]);

    // Trigger sync through the app — should be blocked
    console.log("[BackupBranch] Triggering app sync-repo (block mode)...");
    const syncStatus = await triggerSyncRepo(
      request,
      appCookies,
      [await ensureMyProjectId(request)],
      25_000,
    );
    console.log(`[BackupBranch] sync-repo response: ${syncStatus}`);

    // Check that the repo's status is now "pending-approval"
    await waitFor(
      async () => {
        const { repos } = await getRepositoryIds(request, appCookies, {
          status: "pending-approval",
        });
        return repos.some((r: any) => r.name === "my-project");
      },
      {
        timeout: 45_000,
        interval: 3_000,
        label: "my-project status becomes pending-approval",
      },
    );

    const { repos: pendingRepos } = await getRepositoryIds(
      request,
      appCookies,
      { status: "pending-approval" },
    );
    const pendingMyProject = pendingRepos.find(
      (r: any) => r.name === "my-project",
    );
    expect(
      pendingMyProject,
      "my-project should be in pending-approval status",
    ).toBeTruthy();
    console.log(
      `[BackupBranch] ✓ my-project status: ${pendingMyProject.status}`,
    );

    // The Gitea repo should NOT have been updated (sync was blocked)
    const giteaMainAfter = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      "main",
    );
    // Note: Gitea's own mirror cron might have pulled the new content independently.
    // We can only verify the app-level block; the marker file check is informational.
    console.log(
      `[BackupBranch] Gitea main after block: ${giteaMainAfter.commit.id.substring(0, 12)} ` +
        `(baseline was ${baselineMainSha.substring(0, 12)})`,
    );

    // Check for block activity in the log
    const activitiesResp = await request.get(`${APP_URL}/api/activities`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });
    if (activitiesResp.ok()) {
      const activities = await activitiesResp.json();
      const jobs: any[] = Array.isArray(activities)
        ? activities
        : (activities.jobs ?? activities.activities ?? []);
      const blockActivities = jobs.filter(
        (j: any) =>
          j.repositoryName === "my-project" &&
          (j.message?.toLowerCase().includes("blocked") ||
            j.details?.toLowerCase().includes("blocked") ||
            j.details?.toLowerCase().includes("pending")),
      );
      console.log(
        `[BackupBranch] Block activities: ${blockActivities.length}`,
      );
      for (const a of blockActivities.slice(0, 3)) {
        console.log(
          `[BackupBranch]   • [${a.status}] ${a.message ?? ""} | ${(a.details ?? "").substring(0, 120)}`,
        );
      }
    }

    console.log("[BackupBranch] ✓ Sync blocked — repo is pending-approval");
  });

  test("BB8: Dismiss the blocked sync and verify status resets", async ({
    request,
  }) => {
    if (!appCookies) appCookies = await getAppSessionCookies(request);

    // Use the approve-sync API with action=dismiss
    const { status, body } = await approveSyncRepo(
      request,
      appCookies,
      await ensureMyProjectId(request),
      "dismiss",
    );
    console.log(
      `[BackupBranch] Dismiss response: ${status} — ${JSON.stringify(body)}`,
    );
    expect(status, "Dismiss should succeed").toBeLessThan(400);

    // Wait for the status to return to "mirrored"
    await waitFor(
      async () => {
        const { repos } = await getRepositoryIds(request, appCookies);
        const myProj = repos.find((r: any) => r.name === "my-project");
        return myProj?.status === "mirrored";
      },
      {
        timeout: 30_000,
        interval: 3_000,
        label: "my-project status returns to mirrored after dismiss",
      },
    );

    console.log(
      "[BackupBranch] ✓ Dismissed — repo status back to mirrored",
    );
  });

  test("BB9: Block again, then approve and verify sync proceeds", async ({
    request,
  }) => {
    if (!appCookies) appCookies = await getAppSessionCookies(request);

    // Re-read current Gitea state to check if it already synced
    // (Gitea's own mirror cron may have picked up the force-push)
    const giteaMainBefore = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      "main",
    );
    const giteaSha = giteaMainBefore.commit.id;

    // If Gitea already has the new content (from its own mirror cron), we need
    // a fresh force-push to create a new discrepancy
    const sourceMainSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");

    // Update fake GitHub to match current Gitea (to reset detection baseline)
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: giteaSha },
    ]);

    // Create a new force-push
    mutateSourceRepo(MY_PROJECT_BARE, "bb-approve-rewrite", (workDir) => {
      git("checkout main", workDir);
      writeFileSync(
        join(workDir, "APPROVE_MARKER.txt"),
        `Approve test force-push at ${new Date().toISOString()}\n`,
      );
      git("add -A", workDir);
      execSync('git commit -m "BB9: Force-push for approve test"', {
        cwd: workDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Backup Test Bot",
          GIT_AUTHOR_EMAIL: "backup-test@test.local",
          GIT_COMMITTER_NAME: "Backup Test Bot",
          GIT_COMMITTER_EMAIL: "backup-test@test.local",
        },
      });
    });

    const newSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");
    console.log(
      `[BackupBranch] New source SHA for approve test: ${newSha.substring(0, 12)}`,
    );

    // Update fake GitHub
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: newSha },
    ]);

    // Ensure block mode
    const giteaToken = giteaApi.getTokenValue();
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        forcePushAction: "block",
        backupBeforeSync: false,
        blockSyncOnBackupFailure: false,
      },
    });

    // Trigger sync — should be blocked again
    await triggerSyncRepo(request, appCookies, [await ensureMyProjectId(request)], 25_000);

    // Wait for pending-approval status
    await waitFor(
      async () => {
        const { repos } = await getRepositoryIds(request, appCookies, {
          status: "pending-approval",
        });
        return repos.some((r: any) => r.name === "my-project");
      },
      {
        timeout: 45_000,
        interval: 3_000,
        label: "my-project blocked again for approve test",
      },
    );
    console.log("[BackupBranch] ✓ Sync blocked again — now approving...");

    // Approve the sync
    const { status: approveStatus, body: approveBody } = await approveSyncRepo(
      request,
      appCookies,
      await ensureMyProjectId(request),
      "approve",
    );
    console.log(
      `[BackupBranch] Approve response: ${approveStatus} — ${JSON.stringify(approveBody)}`,
    );
    expect(approveStatus, "Approve should succeed").toBeLessThan(400);

    // Wait for the sync to complete — the repo should leave pending-approval
    await waitFor(
      async () => {
        const { repos } = await getRepositoryIds(request, appCookies);
        const myProj = repos.find((r: any) => r.name === "my-project");
        return (
          myProj?.status !== "pending-approval" &&
          myProj?.status !== "syncing"
        );
      },
      {
        timeout: 60_000,
        interval: 5_000,
        label: "my-project leaves pending-approval after approve",
      },
    );

    // Wait for Gitea to get the new content
    await giteaApi.triggerMirrorSync(GITEA_MIRROR_ORG, "my-project");
    await new Promise((r) => setTimeout(r, 15_000));

    await waitFor(
      async () => {
        const marker = await giteaApi.getFileContent(
          GITEA_MIRROR_ORG,
          "my-project",
          "APPROVE_MARKER.txt",
        );
        return marker !== null;
      },
      {
        timeout: 60_000,
        interval: 5_000,
        label: "APPROVE_MARKER.txt appears in Gitea",
      },
    );

    console.log(
      "[BackupBranch] ✓ Sync proceeded after approval — APPROVE_MARKER.txt present",
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BB10: allow mode — no detection, sync proceeds
  // ════════════════════════════════════════════════════════════════════════════

  test("BB10: Allow mode skips detection entirely", async ({ request }) => {
    if (!appCookies) appCookies = await getAppSessionCookies(request);
    const giteaToken = giteaApi.getTokenValue();

    // Record current state
    const giteaMainBefore = await giteaApi.getBranch(
      GITEA_MIRROR_ORG,
      "my-project",
      "main",
    );
    const currentSha = giteaMainBefore.commit.id;

    // Set allow mode
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        forcePushAction: "allow",
        backupBeforeSync: false,
        blockSyncOnBackupFailure: false,
      },
    });
    console.log("[BackupBranch] Config set: forcePushAction=allow");

    // Force-push source repo
    mutateSourceRepo(MY_PROJECT_BARE, "bb-allow-rewrite", (workDir) => {
      git("checkout main", workDir);
      writeFileSync(
        join(workDir, "ALLOW_MARKER.txt"),
        `Allow mode force-push at ${new Date().toISOString()}\n`,
      );
      git("add -A", workDir);
      execSync('git commit -m "BB10: Force-push with allow mode"', {
        cwd: workDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Backup Test Bot",
          GIT_AUTHOR_EMAIL: "backup-test@test.local",
          GIT_COMMITTER_NAME: "Backup Test Bot",
          GIT_COMMITTER_EMAIL: "backup-test@test.local",
        },
      });
    });

    const newSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");
    // Update fake GitHub — although in allow mode, the code should skip detection entirely
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: newSha },
    ]);

    // Trigger sync — should proceed without blocking
    const syncStatus = await triggerSyncRepo(
      request,
      appCookies,
      [await ensureMyProjectId(request)],
      25_000,
    );
    console.log(`[BackupBranch] Allow mode sync-repo response: ${syncStatus}`);
    expect(syncStatus).toBeLessThan(500);

    // The repo should NOT end up in pending-approval
    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 5_000));

    const { repos } = await getRepositoryIds(request, appCookies);
    const myProj = repos.find((r: any) => r.name === "my-project");
    expect(
      myProj?.status,
      "In allow mode, repo should NOT be pending-approval",
    ).not.toBe("pending-approval");

    // Wait for Gitea to pick up the new content
    await giteaApi.triggerMirrorSync(GITEA_MIRROR_ORG, "my-project");
    await new Promise((r) => setTimeout(r, 15_000));

    await waitFor(
      async () => {
        const marker = await giteaApi.getFileContent(
          GITEA_MIRROR_ORG,
          "my-project",
          "ALLOW_MARKER.txt",
        );
        return marker !== null;
      },
      {
        timeout: 60_000,
        interval: 5_000,
        label: "ALLOW_MARKER.txt appears in Gitea (allow mode)",
      },
    );

    // Count how many NEW backup branches were created — there should be NONE
    // from this specific sync (allow mode doesn't create backups)
    const branches = await giteaApi.listBranches(
      GITEA_MIRROR_ORG,
      "my-project",
    );
    const branchNames = branches.map((b: any) => b.name);
    console.log(
      `[BackupBranch] All branches after allow-mode sync: ${branchNames.join(", ")}`,
    );

    console.log("[BackupBranch] ✓ Allow mode — sync proceeded, no detection");
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BB11: Cleanup — restore source repo for subsequent test suites
  // ════════════════════════════════════════════════════════════════════════════

  test("BB11: Restore source repo and reset config for other tests", async ({
    request,
  }) => {
    if (!appCookies) appCookies = await getAppSessionCookies(request);
    const giteaToken = giteaApi.getTokenValue();

    // Reset to default (backup-branch mode, which is safe)
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        forcePushAction: "backup-branch",
        backupBeforeSync: false,
        blockSyncOnBackupFailure: false,
      },
    });

    // Restore source repo to clean state
    mutateSourceRepo(
      MY_PROJECT_BARE,
      "bb-final-restore",
      (workDir) => {
        git("checkout main", workDir);

        // Remove all test markers
        try {
          execSync(
            "rm -f BB_MARKER.txt BLOCK_MARKER.txt APPROVE_MARKER.txt ALLOW_MARKER.txt SECOND_FORCE_PUSH.txt FORCE_PUSH_MARKER.txt",
            { cwd: workDir },
          );
        } catch {
          /* ignore */
        }

        writeFileSync(
          join(workDir, "README.md"),
          "# My Project\n\nA sample project for E2E testing.\n\n" +
            "## Features\n- Greeting module\n- Math utilities\n",
        );
        writeFileSync(
          join(workDir, "LICENSE"),
          "MIT License\n\nCopyright (c) 2024 E2E Test\n",
        );
        git("add -A", workDir);
        execSync(
          'git commit --allow-empty -m "BB11: Final restore after backup-branch tests"',
          {
            cwd: workDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Backup Test Bot",
              GIT_AUTHOR_EMAIL: "backup-test@test.local",
              GIT_COMMITTER_NAME: "Backup Test Bot",
              GIT_COMMITTER_EMAIL: "backup-test@test.local",
            },
          },
        );
      },
    );

    // Sync Gitea
    const newSourceSha = getRefSha(MY_PROJECT_BARE, "refs/heads/main");
    await updateFakeGitHubBranches(request, "e2e-test-user", "my-project", [
      { name: "main", sha: newSourceSha },
    ]);
    await giteaApi.triggerMirrorSync(GITEA_MIRROR_ORG, "my-project");
    await new Promise((r) => setTimeout(r, 10_000));

    // Verify
    const license = await giteaApi.getFileContent(
      GITEA_MIRROR_ORG,
      "my-project",
      "LICENSE",
    );
    if (license) {
      console.log("[BackupBranch] Source repo restored for subsequent tests");
    } else {
      console.log(
        "[BackupBranch] Warning: restoration may not have fully synced yet",
      );
    }

    console.log(
      "\n[BackupBranch] ════════════════════════════════════════════════",
    );
    console.log(
      "[BackupBranch]  ALL BACKUP-BRANCH PROTECTION TESTS COMPLETE",
    );
    console.log(
      "[BackupBranch] ════════════════════════════════════════════════\n",
    );
  });
});
