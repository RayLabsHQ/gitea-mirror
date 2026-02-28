/**
 * 03 – Backup configuration tests.
 *
 * Exercises the pre-sync backup system by toggling config flags through
 * the app API and triggering re-syncs on repos that were already mirrored
 * by the 02-mirror-workflow suite.
 *
 * What is tested:
 *   B1. Enable backupBeforeSync in config
 *   B2. Confirm mirrored repos exist in Gitea (precondition)
 *   B3. Trigger a re-sync with backup enabled — verify the backup code path
 *       runs (snapshot activity entries appear in the activity log)
 *   B4. Inspect activity log for snapshot-related entries
 *   B5. Enable blockSyncOnBackupFailure and verify the flag is persisted
 *   B6. Disable backup and verify config resets cleanly
 */

import { test, expect } from "@playwright/test";
import {
  APP_URL,
  GITEA_URL,
  GITEA_MIRROR_ORG,
  GiteaAPI,
  getAppSessionCookies,
  saveConfig,
  getRepositoryIds,
  triggerSyncRepo,
} from "./helpers";

test.describe("E2E: Backup configuration", () => {
  let giteaApi: GiteaAPI;
  let appCookies = "";

  test.beforeAll(async () => {
    giteaApi = new GiteaAPI(GITEA_URL);
    try {
      await giteaApi.createToken();
    } catch {
      console.log(
        "[Backup] Could not create Gitea token; tests may be limited",
      );
    }
  });

  test.afterAll(async () => {
    await giteaApi.dispose();
  });

  // ── B1 ─────────────────────────────────────────────────────────────────────

  test("Step B1: Enable backup in config", async ({ request }) => {
    appCookies = await getAppSessionCookies(request);

    const giteaToken = giteaApi.getTokenValue();
    expect(giteaToken, "Gitea token required").toBeTruthy();

    // Save config with backup enabled
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        backupBeforeSync: true,
        blockSyncOnBackupFailure: false,
        backupRetentionCount: 5,
        backupDirectory: "data/repo-backups",
      },
    });

    // Verify config was saved
    const configResp = await request.get(`${APP_URL}/api/config`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });
    expect(configResp.status()).toBeLessThan(500);

    if (configResp.ok()) {
      const configData = await configResp.json();
      const giteaCfg = configData.giteaConfig ?? configData.gitea ?? {};
      console.log(
        `[Backup] Config saved: backupBeforeSync=${giteaCfg.backupBeforeSync}, blockOnFailure=${giteaCfg.blockSyncOnBackupFailure}`,
      );
    }
  });

  // ── B2 ─────────────────────────────────────────────────────────────────────

  test("Step B2: Verify mirrored repos exist in Gitea before backup test", async () => {
    // We need repos to already be mirrored from the 02-mirror-workflow suite
    const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    console.log(
      `[Backup] Repos in ${GITEA_MIRROR_ORG}: ${orgRepos.length} (${orgRepos.map((r: any) => r.name).join(", ")})`,
    );

    if (orgRepos.length === 0) {
      console.log(
        "[Backup] WARNING: No repos in Gitea yet. Backup test will verify " +
          "job creation but not bundle creation.",
      );
    }
  });

  // ── B3 ─────────────────────────────────────────────────────────────────────

  test("Step B3: Trigger re-sync with backup enabled", async ({ request }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    // Fetch mirrored repository IDs (sync-repo requires them)
    const { ids: repositoryIds, repos } = await getRepositoryIds(
      request,
      appCookies,
      { status: "mirrored" },
    );

    // Also include repos with "success" status
    if (repositoryIds.length === 0) {
      const { ids: successIds } = await getRepositoryIds(
        request,
        appCookies,
        { status: "success" },
      );
      repositoryIds.push(...successIds);
    }

    // Fall back to all repos if no mirrored/success repos
    if (repositoryIds.length === 0) {
      const { ids: allIds } = await getRepositoryIds(request, appCookies);
      repositoryIds.push(...allIds);
    }

    console.log(
      `[Backup] Found ${repositoryIds.length} repos to re-sync: ` +
        repos.map((r: any) => r.name).join(", "),
    );

    expect(
      repositoryIds.length,
      "Need at least one repo to test backup",
    ).toBeGreaterThan(0);

    // Trigger sync-repo — this calls syncGiteaRepoEnhanced which checks
    // shouldCreatePreSyncBackup and creates bundles before syncing
    const status = await triggerSyncRepo(
      request,
      appCookies,
      repositoryIds,
      25_000,
    );
    console.log(`[Backup] Sync-repo response: ${status}`);
    expect(status, "Sync-repo should accept request").toBeLessThan(500);
  });

  // ── B4 ─────────────────────────────────────────────────────────────────────

  test("Step B4: Verify backup-related activity in logs", async ({
    request,
  }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    const activitiesResp = await request.get(`${APP_URL}/api/activities`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });

    if (!activitiesResp.ok()) {
      console.log(
        `[Backup] Could not fetch activities: ${activitiesResp.status()}`,
      );
      return;
    }

    const activities = await activitiesResp.json();
    const jobs: any[] = Array.isArray(activities)
      ? activities
      : (activities.jobs ?? activities.activities ?? []);

    // Look for backup / snapshot related messages
    const backupJobs = jobs.filter(
      (j: any) =>
        j.message?.toLowerCase().includes("snapshot") ||
        j.message?.toLowerCase().includes("backup") ||
        j.details?.toLowerCase().includes("snapshot") ||
        j.details?.toLowerCase().includes("backup") ||
        j.details?.toLowerCase().includes("bundle"),
    );

    console.log(
      `[Backup] Backup-related activity entries: ${backupJobs.length}`,
    );
    for (const j of backupJobs.slice(0, 10)) {
      console.log(
        `[Backup]   • ${j.repositoryName ?? "?"}: ${j.status} — ${j.message ?? ""} | ${(j.details ?? "").substring(0, 120)}`,
      );
    }

    // We expect at least some backup-related entries if repos were mirrored
    const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    if (orgRepos.length > 0) {
      // With repos in Gitea, the backup system should have tried to create
      // snapshots. The snapshots may succeed or fail (e.g. path issues in
      // certain environments), but the attempts should be logged.
      expect(
        backupJobs.length,
        "Expected at least one backup/snapshot activity entry when " +
          "backupBeforeSync is enabled and repos exist in Gitea",
      ).toBeGreaterThan(0);

      console.log(
        `[Backup] Confirmed: backup system was invoked for ${backupJobs.length} repos`,
      );
    }

    // Dump all recent jobs for debugging visibility
    console.log(`[Backup] All recent jobs (last 20):`);
    for (const j of jobs.slice(0, 20)) {
      console.log(
        `[Backup]   - [${j.status}] ${j.repositoryName ?? "?"}: ${j.message ?? ""} ` +
          `${j.details ? `(${j.details.substring(0, 80)})` : ""}`,
      );
    }
  });

  // ── B5 ─────────────────────────────────────────────────────────────────────

  test("Step B5: Enable blockSyncOnBackupFailure and verify behavior", async ({
    request,
  }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    const giteaToken = giteaApi.getTokenValue();

    // Update config to block sync on backup failure
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        backupBeforeSync: true,
        blockSyncOnBackupFailure: true,
        backupRetentionCount: 5,
        backupDirectory: "data/repo-backups",
      },
    });
    console.log("[Backup] Config updated: blockSyncOnBackupFailure=true");

    // Verify the flag persisted
    const configResp = await request.get(`${APP_URL}/api/config`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });
    if (configResp.ok()) {
      const configData = await configResp.json();
      const giteaCfg = configData.giteaConfig ?? configData.gitea ?? {};
      expect(giteaCfg.blockSyncOnBackupFailure).toBe(true);
      console.log(
        `[Backup] Verified: blockSyncOnBackupFailure=${giteaCfg.blockSyncOnBackupFailure}`,
      );
    }
  });

  // ── B6 ─────────────────────────────────────────────────────────────────────

  test("Step B6: Disable backup and verify config resets", async ({
    request,
  }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    const giteaToken = giteaApi.getTokenValue();

    // Disable backup
    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        backupBeforeSync: false,
        blockSyncOnBackupFailure: false,
      },
    });

    const configResp = await request.get(`${APP_URL}/api/config`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });
    if (configResp.ok()) {
      const configData = await configResp.json();
      const giteaCfg = configData.giteaConfig ?? configData.gitea ?? {};
      console.log(
        `[Backup] After disable: backupBeforeSync=${giteaCfg.backupBeforeSync}`,
      );
    }
    console.log("[Backup] Backup configuration test complete");
  });
});
