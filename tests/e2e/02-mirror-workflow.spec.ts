/**
 * 02 – Main mirror workflow.
 *
 * Walks through the full first-time user journey:
 *   1. Create Gitea admin user + API token
 *   2. Create the mirror target organization
 *   3. Register / sign-in to the gitea-mirror app
 *   4. Save GitHub + Gitea configuration
 *   5. Trigger a GitHub data sync (pull repo list from fake GitHub)
 *   6. Trigger mirror jobs (push repos into Gitea)
 *   7. Verify repos actually appeared in Gitea with real content
 *   8. Verify mirror job activity and app state
 */

import { test, expect } from "@playwright/test";
import {
  APP_URL,
  GITEA_URL,
  GITEA_MIRROR_ORG,
  GiteaAPI,
  getAppSessionCookies,
  saveConfig,
  waitFor,
  getRepositoryIds,
  triggerMirrorJobs,
} from "./helpers";

test.describe("E2E: Mirror workflow", () => {
  let giteaApi: GiteaAPI;
  let appCookies = "";

  test.beforeAll(async () => {
    giteaApi = new GiteaAPI(GITEA_URL);
  });

  test.afterAll(async () => {
    await giteaApi.dispose();
  });

  test("Step 1: Setup Gitea admin user and token", async () => {
    await giteaApi.ensureAdminUser();
    const token = await giteaApi.createToken();
    expect(token).toBeTruthy();
    expect(token.length).toBeGreaterThan(10);
    console.log(`[Setup] Gitea token acquired (length: ${token.length})`);
  });

  test("Step 2: Create mirror organization in Gitea", async () => {
    await giteaApi.ensureOrg(GITEA_MIRROR_ORG);

    const repos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    expect(Array.isArray(repos)).toBeTruthy();
    console.log(
      `[Setup] Org ${GITEA_MIRROR_ORG} exists with ${repos.length} repos`,
    );
  });

  test("Step 3: Register and sign in to gitea-mirror app", async ({
    request,
  }) => {
    appCookies = await getAppSessionCookies(request);
    expect(appCookies).toBeTruthy();
    console.log(
      `[Auth] Session cookies acquired (length: ${appCookies.length})`,
    );

    const whoami = await request.get(`${APP_URL}/api/config`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });
    expect(
      whoami.status(),
      `Auth check returned ${whoami.status()} – cookies may be invalid`,
    ).not.toBe(401);
    console.log(`[Auth] Auth check status: ${whoami.status()}`);
  });

  test("Step 4: Configure mirrors via API (backup disabled)", async ({
    request,
  }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    const giteaToken = giteaApi.getTokenValue();
    expect(giteaToken, "Gitea token should be set from Step 1").toBeTruthy();

    await saveConfig(request, giteaToken, appCookies, {
      giteaConfig: {
        backupBeforeSync: false,
        blockSyncOnBackupFailure: false,
      },
    });
    console.log("[Config] Configuration saved (backup disabled)");
  });

  test("Step 5: Trigger GitHub data sync (fetch repos from fake GitHub)", async ({
    request,
  }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    const syncResp = await request.post(`${APP_URL}/api/sync`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: appCookies,
      },
      failOnStatusCode: false,
    });

    const status = syncResp.status();
    console.log(`[Sync] GitHub sync response: ${status}`);

    if (status >= 400) {
      const body = await syncResp.text();
      console.log(`[Sync] Error body: ${body}`);
    }

    expect(status, "Sync should not be unauthorized").not.toBe(401);
    expect(status, "Sync should not return server error").toBeLessThan(500);

    if (syncResp.ok()) {
      const data = await syncResp.json();
      console.log(
        `[Sync] New repos: ${data.newRepositories ?? "?"}, new orgs: ${data.newOrganizations ?? "?"}`,
      );
    }
  });

  test("Step 6: Trigger mirror jobs (push repos to Gitea)", async ({
    request,
  }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    // Fetch repository IDs from the dashboard API
    const { ids: repositoryIds, repos } = await getRepositoryIds(
      request,
      appCookies,
    );
    console.log(
      `[Mirror] Found ${repositoryIds.length} repos to mirror: ${repos.map((r: any) => r.name).join(", ")}`,
    );

    if (repositoryIds.length === 0) {
      // Fallback: try the github/repositories endpoint
      const repoResp = await request.get(
        `${APP_URL}/api/github/repositories`,
        {
          headers: { Cookie: appCookies },
          failOnStatusCode: false,
        },
      );
      if (repoResp.ok()) {
        const repoData = await repoResp.json();
        const fallbackRepos: any[] = Array.isArray(repoData)
          ? repoData
          : (repoData.repositories ?? []);
        repositoryIds.push(...fallbackRepos.map((r: any) => r.id));
        console.log(
          `[Mirror] Fallback: found ${repositoryIds.length} repos`,
        );
      }
    }

    expect(
      repositoryIds.length,
      "Should have at least one repository to mirror",
    ).toBeGreaterThan(0);

    const status = await triggerMirrorJobs(
      request,
      appCookies,
      repositoryIds,
      30_000,
    );
    console.log(`[Mirror] Mirror job response: ${status}`);

    expect(status, "Mirror job should not be unauthorized").not.toBe(401);
    expect(status, "Mirror job should not return server error").toBeLessThan(
      500,
    );
  });

  test("Step 7: Verify repos were actually mirrored to Gitea", async ({
    request,
  }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    // Wait for mirror jobs to finish processing
    await waitFor(
      async () => {
        const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
        console.log(
          `[Verify] Gitea org repos so far: ${orgRepos.length} (${orgRepos.map((r: any) => r.name).join(", ")})`,
        );
        // We expect at least 3 repos (my-project, dotfiles, notes)
        return orgRepos.length >= 3;
      },
      {
        timeout: 90_000,
        interval: 5_000,
        label: "repos appear in Gitea",
      },
    );

    const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    const orgRepoNames = orgRepos.map((r: any) => r.name);
    console.log(
      `[Verify] Gitea org repos: ${orgRepoNames.join(", ")} (total: ${orgRepos.length})`,
    );

    // Check that at least the 3 personal repos are mirrored
    for (const repoName of ["my-project", "dotfiles", "notes"]) {
      expect(
        orgRepoNames,
        `Expected repo "${repoName}" to be mirrored into org ${GITEA_MIRROR_ORG}`,
      ).toContain(repoName);
    }

    // Verify my-project has actual content (branches, commits)
    const myProjectBranches = await giteaApi.listBranches(
      GITEA_MIRROR_ORG,
      "my-project",
    );
    const branchNames = myProjectBranches.map((b: any) => b.name);
    console.log(`[Verify] my-project branches: ${branchNames.join(", ")}`);
    expect(branchNames, "main branch should exist").toContain("main");

    // Verify we can read actual file content
    const readmeContent = await giteaApi.getFileContent(
      GITEA_MIRROR_ORG,
      "my-project",
      "README.md",
    );
    expect(readmeContent, "README.md should have content").toBeTruthy();
    expect(readmeContent).toContain("My Project");
    console.log(
      `[Verify] my-project README.md starts with: ${readmeContent?.substring(0, 50)}...`,
    );

    // Verify tags were mirrored
    const tags = await giteaApi.listTags(GITEA_MIRROR_ORG, "my-project");
    const tagNames = tags.map((t: any) => t.name);
    console.log(`[Verify] my-project tags: ${tagNames.join(", ")}`);
    if (tagNames.length > 0) {
      expect(tagNames).toContain("v1.0.0");
    }

    // Verify commits exist
    const commits = await giteaApi.listCommits(
      GITEA_MIRROR_ORG,
      "my-project",
    );
    console.log(`[Verify] my-project commits: ${commits.length}`);
    expect(commits.length, "Should have multiple commits").toBeGreaterThan(0);

    // Verify dotfiles repo has content
    const bashrc = await giteaApi.getFileContent(
      GITEA_MIRROR_ORG,
      "dotfiles",
      ".bashrc",
    );
    expect(bashrc, "dotfiles should contain .bashrc").toBeTruthy();
    console.log("[Verify] dotfiles .bashrc verified");
  });

  test("Step 8: Verify mirror jobs and app state", async ({ request }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    // Check activity log
    const activitiesResp = await request.get(`${APP_URL}/api/activities`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });

    if (activitiesResp.ok()) {
      const activities = await activitiesResp.json();
      const jobs: any[] = Array.isArray(activities)
        ? activities
        : (activities.jobs ?? activities.activities ?? []);
      console.log(`[State] Activity/job records: ${jobs.length}`);

      const mirrorJobs = jobs.filter(
        (j: any) =>
          j.status === "mirroring" ||
          j.status === "failed" ||
          j.status === "success" ||
          j.status === "mirrored" ||
          j.message?.includes("mirror") ||
          j.message?.includes("Mirror"),
      );
      console.log(`[State] Mirror-related jobs: ${mirrorJobs.length}`);
      for (const j of mirrorJobs.slice(0, 5)) {
        console.log(
          `[State]   • ${j.repositoryName ?? "?"}: ${j.status} — ${j.message ?? ""}`,
        );
      }
    }

    // Check dashboard repos
    const dashResp = await request.get(`${APP_URL}/api/dashboard`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });

    if (dashResp.ok()) {
      const dashData = await dashResp.json();
      const repos: any[] = dashData.repositories ?? [];
      console.log(`[State] Dashboard repos: ${repos.length}`);

      for (const r of repos) {
        console.log(
          `[State]   • ${r.name}: status=${r.status}, mirrored=${r.mirroredLocation ?? "none"}`,
        );
      }

      expect(repos.length, "Repos should exist in DB").toBeGreaterThan(0);

      const succeeded = repos.filter(
        (r: any) => r.status === "mirrored" || r.status === "success",
      );
      console.log(
        `[State] Successfully mirrored repos: ${succeeded.length}/${repos.length}`,
      );
    }

    // App should still be running
    const healthResp = await request.get(`${APP_URL}/`, {
      failOnStatusCode: false,
    });
    expect(
      healthResp.status(),
      "App should still be running after mirror attempts",
    ).toBeLessThan(500);
    console.log(`[State] App health: ${healthResp.status()}`);
  });
});
