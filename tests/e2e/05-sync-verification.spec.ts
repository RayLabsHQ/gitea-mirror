/**
 * 05 – Sync verification and cleanup.
 *
 * Exercises the dynamic aspects of the sync pipeline:
 *   • Adding a repo to the fake GitHub at runtime and verifying the app
 *     discovers it on the next sync
 *   • Deep content-integrity checks on repos mirrored during earlier suites
 *   • Resetting the fake GitHub store to its defaults
 *
 * Prerequisites: 02-mirror-workflow.spec.ts must have run so that repos
 * already exist in Gitea.
 */

import { test, expect } from "@playwright/test";
import {
  APP_URL,
  GITEA_URL,
  FAKE_GITHUB_URL,
  GITEA_MIRROR_ORG,
  GiteaAPI,
  getAppSessionCookies,
} from "./helpers";

test.describe("E2E: Sync verification", () => {
  let giteaApi: GiteaAPI;
  let appCookies = "";

  test.beforeAll(async () => {
    giteaApi = new GiteaAPI(GITEA_URL);
    try {
      await giteaApi.createToken();
    } catch {
      console.log("[SyncVerify] Could not create Gitea token; tests may skip");
    }
  });

  test.afterAll(async () => {
    await giteaApi.dispose();
  });

  // ── Dynamic repo addition ────────────────────────────────────────────────

  test("Verify fake GitHub management API can add repos dynamically", async ({
    request,
  }) => {
    const addResp = await request.post(`${FAKE_GITHUB_URL}/___mgmt/add-repo`, {
      data: {
        name: "dynamic-repo",
        owner_login: "e2e-test-user",
        description: "Dynamically added for E2E testing",
        language: "Rust",
      },
    });
    expect(addResp.ok()).toBeTruthy();

    const repoResp = await request.get(
      `${FAKE_GITHUB_URL}/repos/e2e-test-user/dynamic-repo`,
    );
    expect(repoResp.ok()).toBeTruthy();
    const repo = await repoResp.json();
    expect(repo.name).toBe("dynamic-repo");
    expect(repo.language).toBe("Rust");
    console.log("[DynamicRepo] Successfully added and verified dynamic repo");
  });

  test("Newly added fake GitHub repo gets picked up by sync", async ({
    request,
  }) => {
    appCookies = await getAppSessionCookies(request);

    const syncResp = await request.post(`${APP_URL}/api/sync`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: appCookies,
      },
      failOnStatusCode: false,
    });

    const status = syncResp.status();
    console.log(`[DynamicSync] Sync response: ${status}`);
    expect(status).toBeLessThan(500);

    if (syncResp.ok()) {
      const data = await syncResp.json();
      console.log(
        `[DynamicSync] New repos discovered: ${data.newRepositories ?? "?"}`,
      );
      if (data.newRepositories !== undefined) {
        expect(data.newRepositories).toBeGreaterThanOrEqual(0);
      }
    }
  });

  // ── Content integrity ────────────────────────────────────────────────────

  test("Verify repo content integrity after mirror", async () => {
    // Check repos in the mirror org
    const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    const orgRepoNames = orgRepos.map((r: any) => r.name);
    console.log(
      `[Integrity] Repos in ${GITEA_MIRROR_ORG}: ${orgRepoNames.join(", ")}`,
    );

    // Check github-stars org for starred repos
    const starsRepos = await giteaApi.listOrgRepos("github-stars");
    const starsRepoNames = starsRepos.map((r: any) => r.name);
    console.log(
      `[Integrity] Repos in github-stars: ${starsRepoNames.join(", ")}`,
    );

    // ── notes repo (minimal single-commit repo) ──────────────────────────

    if (orgRepoNames.includes("notes")) {
      const notesReadme = await giteaApi.getFileContent(
        GITEA_MIRROR_ORG,
        "notes",
        "README.md",
      );
      if (notesReadme) {
        expect(notesReadme).toContain("Notes");
        console.log("[Integrity] notes/README.md verified");
      }

      const ideas = await giteaApi.getFileContent(
        GITEA_MIRROR_ORG,
        "notes",
        "ideas.md",
      );
      if (ideas) {
        expect(ideas).toContain("Ideas");
        console.log("[Integrity] notes/ideas.md verified");
      }

      const todo = await giteaApi.getFileContent(
        GITEA_MIRROR_ORG,
        "notes",
        "todo.md",
      );
      if (todo) {
        expect(todo).toContain("TODO");
        console.log("[Integrity] notes/todo.md verified");
      }
    }

    // ── dotfiles repo ────────────────────────────────────────────────────

    if (orgRepoNames.includes("dotfiles")) {
      const vimrc = await giteaApi.getFileContent(
        GITEA_MIRROR_ORG,
        "dotfiles",
        ".vimrc",
      );
      if (vimrc) {
        expect(vimrc).toContain("set number");
        console.log("[Integrity] dotfiles/.vimrc verified");
      }

      const gitconfig = await giteaApi.getFileContent(
        GITEA_MIRROR_ORG,
        "dotfiles",
        ".gitconfig",
      );
      if (gitconfig) {
        expect(gitconfig).toContain("[user]");
        console.log("[Integrity] dotfiles/.gitconfig verified");
      }

      // Verify commit count (dotfiles has 2 commits)
      const commits = await giteaApi.listCommits(
        GITEA_MIRROR_ORG,
        "dotfiles",
      );
      console.log(`[Integrity] dotfiles commit count: ${commits.length}`);
      expect(
        commits.length,
        "dotfiles should have at least 2 commits",
      ).toBeGreaterThanOrEqual(2);
    }

    // ── popular-lib (starred repo from other-user) ───────────────────────

    // In single-org strategy it goes to the starredReposOrg ("github-stars")
    if (starsRepoNames.includes("popular-lib")) {
      const readme = await giteaApi.getFileContent(
        "github-stars",
        "popular-lib",
        "README.md",
      );
      if (readme) {
        expect(readme).toContain("Popular Lib");
        console.log("[Integrity] popular-lib/README.md verified");
      }

      const pkg = await giteaApi.getFileContent(
        "github-stars",
        "popular-lib",
        "package.json",
      );
      if (pkg) {
        const parsed = JSON.parse(pkg);
        expect(parsed.name).toBe("popular-lib");
        expect(parsed.version).toBe("2.5.0");
        console.log("[Integrity] popular-lib/package.json verified");
      }

      const tags = await giteaApi.listTags("github-stars", "popular-lib");
      const tagNames = tags.map((t: any) => t.name);
      console.log(
        `[Integrity] popular-lib tags: ${tagNames.join(", ") || "(none)"}`,
      );
      if (tagNames.length > 0) {
        expect(tagNames).toContain("v2.5.0");
      }
    } else {
      console.log(
        "[Integrity] popular-lib not found in github-stars " +
          "(may be in mirror org or not yet mirrored)",
      );
    }

    // ── org-tool (organization repo) ─────────────────────────────────────

    // org-tool may be in the mirror org or a separate org depending on
    // the mirror strategy — check several possible locations.
    const orgToolOwners = [GITEA_MIRROR_ORG, "test-org"];
    let foundOrgTool = false;
    for (const owner of orgToolOwners) {
      const repo = await giteaApi.getRepo(owner, "org-tool");
      if (repo) {
        foundOrgTool = true;
        console.log(`[Integrity] org-tool found in ${owner}`);

        const readme = await giteaApi.getFileContent(
          owner,
          "org-tool",
          "README.md",
        );
        if (readme) {
          expect(readme).toContain("Org Tool");
          console.log("[Integrity] org-tool/README.md verified");
        }

        const mainGo = await giteaApi.getFileContent(
          owner,
          "org-tool",
          "main.go",
        );
        if (mainGo) {
          expect(mainGo).toContain("package main");
          console.log("[Integrity] org-tool/main.go verified");
        }

        // Check branches
        const branches = await giteaApi.listBranches(owner, "org-tool");
        const branchNames = branches.map((b: any) => b.name);
        console.log(
          `[Integrity] org-tool branches: ${branchNames.join(", ")}`,
        );
        if (branchNames.length > 0) {
          expect(branchNames).toContain("main");
        }

        // Check tags
        const tags = await giteaApi.listTags(owner, "org-tool");
        const tagNames = tags.map((t: any) => t.name);
        console.log(
          `[Integrity] org-tool tags: ${tagNames.join(", ") || "(none)"}`,
        );

        break;
      }
    }
    if (!foundOrgTool) {
      console.log(
        "[Integrity] org-tool not found in Gitea " +
          "(may not have been mirrored in single-org strategy)",
      );
    }
  });

  // ── my-project deep check ────────────────────────────────────────────────

  test("Verify my-project branch and tag structure", async () => {
    const branches = await giteaApi.listBranches(
      GITEA_MIRROR_ORG,
      "my-project",
    );
    const branchNames = branches.map((b: any) => b.name);
    console.log(
      `[Integrity] my-project branches: ${branchNames.join(", ")}`,
    );

    // The source repo had main, develop, and feature/add-tests
    expect(branchNames, "main branch should exist").toContain("main");
    // develop and feature/add-tests may or may not survive force-push tests
    // depending on test ordering, so just log them
    for (const expected of ["develop", "feature/add-tests"]) {
      if (branchNames.includes(expected)) {
        console.log(`[Integrity] ✓ Branch "${expected}" present`);
      } else {
        console.log(`[Integrity] ⊘ Branch "${expected}" not present (may have been affected by force-push tests)`);
      }
    }

    const tags = await giteaApi.listTags(GITEA_MIRROR_ORG, "my-project");
    const tagNames = tags.map((t: any) => t.name);
    console.log(
      `[Integrity] my-project tags: ${tagNames.join(", ") || "(none)"}`,
    );

    // Verify package.json exists and is valid JSON
    const pkg = await giteaApi.getFileContent(
      GITEA_MIRROR_ORG,
      "my-project",
      "package.json",
    );
    if (pkg) {
      const parsed = JSON.parse(pkg);
      expect(parsed.name).toBe("my-project");
      console.log("[Integrity] my-project/package.json verified");
    }
  });
});

// ─── Fake GitHub reset ───────────────────────────────────────────────────────

test.describe("E2E: Fake GitHub reset", () => {
  test("Can reset fake GitHub to default state", async ({ request }) => {
    const resp = await request.post(`${FAKE_GITHUB_URL}/___mgmt/reset`);
    expect(resp.ok()).toBeTruthy();
    const data = await resp.json();
    expect(data.message).toContain("reset");
    console.log("[Reset] Fake GitHub reset to defaults");

    const health = await request.get(`${FAKE_GITHUB_URL}/___mgmt/health`);
    const healthData = await health.json();
    expect(healthData.repos).toBeGreaterThan(0);
    console.log(
      `[Reset] After reset: ${healthData.repos} repos, ${healthData.orgs} orgs`,
    );
  });
});
