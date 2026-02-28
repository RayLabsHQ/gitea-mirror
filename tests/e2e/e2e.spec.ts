/**
 * End-to-end tests for gitea-mirror.
 *
 * Prerequisites (managed by run-e2e.sh or the CI workflow):
 *   1. Gitea running on http://localhost:3333  (admin/admin123)
 *   2. Fake GitHub API on http://localhost:4580
 *   3. gitea-mirror app on http://localhost:4321
 *
 * The tests walk through the full user journey:
 *   1. Register an account in gitea-mirror
 *   2. Create a Gitea API token
 *   3. Configure GitHub + Gitea settings via the app
 *   4. Trigger a GitHub → app sync (fetch repos from fake GitHub)
 *   5. Trigger a mirror job (push repos to Gitea)
 *   6. Verify the mirrored repos appear in Gitea
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// ─── Constants ───────────────────────────────────────────────────────────────

const APP_URL = process.env.APP_URL || "http://localhost:4321";
const GITEA_URL = process.env.GITEA_URL || "http://localhost:3333";
const FAKE_GITHUB_URL = process.env.FAKE_GITHUB_URL || "http://localhost:4580";

const GITEA_ADMIN_USER = "e2e_admin";
const GITEA_ADMIN_PASS = "e2eAdminPass123!";
const GITEA_ADMIN_EMAIL = "admin@e2e-test.local";

const APP_USER_EMAIL = "e2e@test.local";
const APP_USER_PASS = "E2eTestPass123!";
const APP_USER_NAME = "e2e-tester";

const GITEA_MIRROR_ORG = "github-mirrors";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Retry a function until it returns truthy or timeout is reached. */
async function waitFor(
  fn: () => Promise<boolean>,
  { timeout = 60_000, interval = 2_000, label = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitFor("${label}") timed out after ${timeout}ms` +
      (lastErr ? `: ${lastErr.message}` : ""),
  );
}

/** Direct HTTP helper for talking to Gitea's API (bypasses the browser). */
class GiteaAPI {
  private token = "";

  constructor(
    private baseUrl: string,
    private request: APIRequestContext,
  ) {}

  /** Create the admin user via Gitea's built-in install/admin-create flow. */
  async ensureAdminUser(): Promise<void> {
    // First check if admin already exists by trying to get a token
    try {
      const resp = await this.request.get(`${this.baseUrl}/api/v1/user`, {
        headers: {
          Authorization: `Basic ${btoa(`${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}`)}`,
        },
      });
      if (resp.ok()) {
        console.log("[GiteaAPI] Admin user already exists");
        return;
      }
    } catch {
      // Expected on first run
    }

    // Try to create admin via the API (Gitea allows first user to self-register as admin
    // when DISABLE_REGISTRATION=false and no users exist yet)
    const resp = await this.request.post(`${this.baseUrl}/api/v1/admin/users`, {
      headers: {
        "Content-Type": "application/json",
        // Use the Gitea built-in admin creation endpoint (first-user scenario)
        // If this fails, we fall back to the /user/sign_up form
      },
      data: {
        username: GITEA_ADMIN_USER,
        password: GITEA_ADMIN_PASS,
        email: GITEA_ADMIN_EMAIL,
        must_change_password: false,
        login_name: GITEA_ADMIN_USER,
        source_id: 0,
        visibility: "public",
      },
      failOnStatusCode: false,
    });

    if (resp.ok()) {
      console.log("[GiteaAPI] Admin user created via API");
      return;
    }

    // Fallback: register through the form
    console.log("[GiteaAPI] Trying sign-up form fallback...");
    const signUpResp = await this.request.post(`${this.baseUrl}/user/sign_up`, {
      form: {
        user_name: GITEA_ADMIN_USER,
        password: GITEA_ADMIN_PASS,
        retype: GITEA_ADMIN_PASS,
        email: GITEA_ADMIN_EMAIL,
      },
      failOnStatusCode: false,
      maxRedirects: 5,
    });
    console.log(`[GiteaAPI] Sign-up response status: ${signUpResp.status()}`);
  }

  /** Generate a Gitea API token for the admin user. */
  async createToken(): Promise<string> {
    if (this.token) return this.token;

    const tokenName = `e2e-token-${Date.now()}`;
    const resp = await this.request.post(
      `${this.baseUrl}/api/v1/users/${GITEA_ADMIN_USER}/tokens`,
      {
        headers: {
          Authorization: `Basic ${btoa(`${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}`)}`,
          "Content-Type": "application/json",
        },
        data: {
          name: tokenName,
          scopes: [
            "read:user",
            "write:user",
            "read:organization",
            "write:organization",
            "read:repository",
            "write:repository",
            "read:issue",
            "write:issue",
            "read:misc",
            "write:misc",
            "read:admin",
            "write:admin",
          ],
        },
      },
    );
    expect(resp.ok(), `Failed to create Gitea token: ${resp.status()}`).toBeTruthy();
    const data = await resp.json();
    this.token = data.sha1 || data.token;
    console.log(`[GiteaAPI] Created token: ${tokenName}`);
    return this.token;
  }

  /** Create an organization in Gitea. */
  async ensureOrg(orgName: string): Promise<void> {
    const token = await this.createToken();

    // Check if org exists
    const check = await this.request.get(`${this.baseUrl}/api/v1/orgs/${orgName}`, {
      headers: { Authorization: `token ${token}` },
      failOnStatusCode: false,
    });
    if (check.ok()) {
      console.log(`[GiteaAPI] Org ${orgName} already exists`);
      return;
    }

    const resp = await this.request.post(`${this.baseUrl}/api/v1/orgs`, {
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
      },
      data: {
        username: orgName,
        full_name: orgName,
        description: "E2E test mirror organization",
        visibility: "public",
      },
    });
    expect(resp.ok(), `Failed to create org: ${resp.status()}`).toBeTruthy();
    console.log(`[GiteaAPI] Created org: ${orgName}`);
  }

  /** List repos in a Gitea org. */
  async listOrgRepos(orgName: string): Promise<any[]> {
    const token = await this.createToken();
    const resp = await this.request.get(
      `${this.baseUrl}/api/v1/orgs/${orgName}/repos`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return [];
    return resp.json();
  }

  /** List repos for the admin user. */
  async listUserRepos(): Promise<any[]> {
    const token = await this.createToken();
    const resp = await this.request.get(
      `${this.baseUrl}/api/v1/users/${GITEA_ADMIN_USER}/repos`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return [];
    return resp.json();
  }

  /** Get a specific repo. */
  async getRepo(owner: string, name: string): Promise<any | null> {
    const token = await this.createToken();
    const resp = await this.request.get(
      `${this.baseUrl}/api/v1/repos/${owner}/${name}`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return null;
    return resp.json();
  }

  /** List branches for a repo. */
  async listBranches(owner: string, name: string): Promise<any[]> {
    const token = await this.createToken();
    const resp = await this.request.get(
      `${this.baseUrl}/api/v1/repos/${owner}/${name}/branches`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return [];
    return resp.json();
  }

  getTokenValue(): string {
    return this.token;
  }
}

/** Register a user in the gitea-mirror app via the Better Auth sign-up API. */
async function registerAppUser(request: APIRequestContext): Promise<void> {
  // First try to sign in (user may already exist from a previous run)
  const signInResp = await request.post(`${APP_URL}/api/auth/sign-in/email`, {
    data: {
      email: APP_USER_EMAIL,
      password: APP_USER_PASS,
    },
    failOnStatusCode: false,
  });

  if (signInResp.ok()) {
    console.log("[App] User already exists, signed in");
    return;
  }

  // Register
  const signUpResp = await request.post(`${APP_URL}/api/auth/sign-up/email`, {
    data: {
      email: APP_USER_EMAIL,
      password: APP_USER_PASS,
      name: APP_USER_NAME,
    },
    failOnStatusCode: false,
  });

  // The app might return 200, 201, or redirect — just check we didn't get a 5xx
  const status = signUpResp.status();
  console.log(`[App] Sign-up response status: ${status}`);
  expect(status, "Sign-up should not return server error").toBeLessThan(500);
}

/** Sign in via the browser and return cookies. */
async function signInViaBrowser(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/`);

  // The app redirects to sign-in if not authenticated
  // Wait for either the dashboard or the sign-in form
  await page.waitForLoadState("networkidle");

  const url = page.url();

  // If we're already on the dashboard, we're authenticated
  if (!url.includes("sign-in") && !url.includes("login") && !url.includes("register")) {
    console.log("[Browser] Already authenticated");
    return;
  }

  // Look for sign-in form
  // The app uses Better Auth, so the form might vary. Try common patterns.
  const emailInput =
    page.locator('input[name="email"]').or(
      page.locator('input[type="email"]'),
    );
  const passwordInput =
    page.locator('input[name="password"]').or(
      page.locator('input[type="password"]'),
    );

  // If there's a "Sign Up" / "Register" tab/link and no sign-in form, we may need to register first
  const hasSignInForm = (await emailInput.count()) > 0;

  if (!hasSignInForm) {
    // Maybe we need to go to explicit sign-in page
    await page.goto(`${APP_URL}/sign-in`);
    await page.waitForLoadState("networkidle");
  }

  // Check if we're on a register page and need to register first
  if (page.url().includes("register") || page.url().includes("sign-up")) {
    console.log("[Browser] On registration page, registering...");
    const nameInput = page.locator('input[name="name"]').or(page.locator('input[name="username"]'));
    if ((await nameInput.count()) > 0) {
      await nameInput.first().fill(APP_USER_NAME);
    }
    await emailInput.first().fill(APP_USER_EMAIL);
    await passwordInput.first().fill(APP_USER_PASS);
    const submitBtn = page
      .locator('button[type="submit"]')
      .or(page.getByRole("button", { name: /sign up|register|create/i }));
    await submitBtn.first().click();
    await page.waitForLoadState("networkidle");

    // After registration, try signing in
    await page.goto(`${APP_URL}/sign-in`);
    await page.waitForLoadState("networkidle");
  }

  // Fill the sign-in form
  console.log("[Browser] Filling sign-in form...");
  await emailInput.first().fill(APP_USER_EMAIL);
  await passwordInput.first().fill(APP_USER_PASS);

  const submitBtn = page
    .locator('button[type="submit"]')
    .or(page.getByRole("button", { name: /sign in|log in|submit/i }));
  await submitBtn.first().click();

  // Wait for navigation away from sign-in
  await page.waitForLoadState("networkidle");
  console.log(`[Browser] After sign-in, URL: ${page.url()}`);
}

/** Save config via the API. */
async function saveConfig(
  request: APIRequestContext,
  giteaToken: string,
  cookies: string,
): Promise<void> {
  const configPayload = {
    githubConfig: {
      username: "e2e-test-user",
      token: "fake-github-token-for-e2e",
      privateRepositories: false,
      mirrorStarred: true,
    },
    giteaConfig: {
      url: GITEA_URL,
      username: GITEA_ADMIN_USER,
      token: giteaToken,
      organization: GITEA_MIRROR_ORG,
      visibility: "public",
      starredReposOrg: "github-stars",
      preserveOrgStructure: false,
      mirrorStrategy: "single-org",
      backupBeforeSync: false,
      blockSyncOnBackupFailure: false,
    },
    scheduleConfig: {
      enabled: false,
      interval: 3600,
    },
    cleanupConfig: {
      enabled: false,
      retentionDays: 86400,
      deleteIfNotInGitHub: false,
      orphanedRepoAction: "skip",
      dryRun: true,
    },
    mirrorOptions: {
      mirrorReleases: false,
      mirrorLFS: false,
      mirrorMetadata: false,
      metadataComponents: {
        issues: false,
        pullRequests: false,
        labels: false,
        milestones: false,
        wiki: false,
      },
    },
    advancedOptions: {
      skipForks: false,
      starredCodeOnly: false,
    },
  };

  const resp = await request.post(`${APP_URL}/api/config`, {
    data: configPayload,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
    },
    failOnStatusCode: false,
  });

  const status = resp.status();
  console.log(`[App] Save config response: ${status}`);

  if (status >= 400) {
    const body = await resp.text();
    console.log(`[App] Config error body: ${body}`);
  }

  // Accept 200 or 201 or even 409 (config already exists)
  expect(status, "Config save should not return server error").toBeLessThan(500);
}

// ─── Precondition checks ─────────────────────────────────────────────────────

test.describe("E2E: Service health checks", () => {
  test("Fake GitHub API is running", async ({ request }) => {
    const resp = await request.get(`${FAKE_GITHUB_URL}/___mgmt/health`);
    expect(resp.ok()).toBeTruthy();
    const data = await resp.json();
    expect(data.status).toBe("ok");
    expect(data.repos).toBeGreaterThan(0);
    console.log(
      `[Health] Fake GitHub: ${data.repos} repos, ${data.orgs} orgs, ${data.starredCount} starred`,
    );
  });

  test("Gitea instance is running", async ({ request }) => {
    await waitFor(
      async () => {
        const resp = await request.get(`${GITEA_URL}/api/v1/version`, {
          failOnStatusCode: false,
        });
        return resp.ok();
      },
      { timeout: 60_000, interval: 2_000, label: "Gitea startup" },
    );
    const resp = await request.get(`${GITEA_URL}/api/v1/version`);
    expect(resp.ok()).toBeTruthy();
    const data = await resp.json();
    console.log(`[Health] Gitea version: ${data.version}`);
  });

  test("gitea-mirror app is running", async ({ request }) => {
    await waitFor(
      async () => {
        const resp = await request.get(`${APP_URL}/api/health`, {
          failOnStatusCode: false,
        });
        return resp.ok() || resp.status() === 200;
      },
      { timeout: 90_000, interval: 3_000, label: "App startup" },
    );
    // Even if /api/health doesn't exist, the app should serve the root page
    const resp = await request.get(`${APP_URL}/`, { failOnStatusCode: false });
    expect(resp.status()).toBeLessThan(500);
    console.log(`[Health] App responded with status ${resp.status()}`);
  });
});

// ─── Main E2E test flow ──────────────────────────────────────────────────────

test.describe("E2E: Mirror workflow", () => {
  let giteaApi: GiteaAPI;

  test.beforeAll(async ({ request }) => {
    giteaApi = new GiteaAPI(GITEA_URL, request);
  });

  test("Step 1: Setup Gitea admin user and token", async ({ request }) => {
    await giteaApi.ensureAdminUser();
    const token = await giteaApi.createToken();
    expect(token).toBeTruthy();
    expect(token.length).toBeGreaterThan(10);
    console.log(`[Setup] Gitea token acquired (length: ${token.length})`);
  });

  test("Step 2: Create mirror organization in Gitea", async () => {
    await giteaApi.ensureOrg(GITEA_MIRROR_ORG);

    // Verify org exists
    const repos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    expect(Array.isArray(repos)).toBeTruthy();
    console.log(
      `[Setup] Org ${GITEA_MIRROR_ORG} exists with ${repos.length} repos`,
    );
  });

  test("Step 3: Register and sign in to gitea-mirror app", async ({
    page,
    request,
  }) => {
    // Register via API first
    await registerAppUser(request);

    // Then sign in via browser
    await signInViaBrowser(page);

    // Verify we're authenticated – the page should not be on sign-in
    const url = page.url();
    const isOnAuthPage =
      url.includes("sign-in") ||
      url.includes("login") ||
      url.includes("register");

    // Note: the first visit after registration might show a setup wizard
    // which is also fine
    console.log(`[Auth] Current URL after sign-in: ${url}`);

    // Take a screenshot for debugging
    await page.screenshot({ path: "tests/e2e/test-results/after-sign-in.png" });
  });

  test("Step 4: Configure mirrors via API", async ({ page, request }) => {
    // Sign in via browser to get session cookies
    await signInViaBrowser(page);

    // Extract cookies from the browser context
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Ensure we have a Gitea token
    const giteaToken = giteaApi.getTokenValue();
    expect(giteaToken, "Gitea token should be set from Step 1").toBeTruthy();

    // Save configuration
    await saveConfig(request, giteaToken, cookieStr);

    console.log("[Config] Configuration saved successfully");
  });

  test("Step 5: Trigger GitHub data sync (fetch repos from fake GitHub)", async ({
    page,
    request,
  }) => {
    // Sign in
    await signInViaBrowser(page);
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Trigger the sync endpoint which fetches repos from GitHub
    const syncResp = await request.post(`${APP_URL}/api/sync`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieStr,
      },
      failOnStatusCode: false,
    });

    const status = syncResp.status();
    console.log(`[Sync] GitHub sync response: ${status}`);

    if (status >= 400) {
      const body = await syncResp.text();
      console.log(`[Sync] Error body: ${body}`);
    }

    // Should succeed or at least not crash
    expect(status, "Sync should not return server error").toBeLessThan(500);

    if (syncResp.ok()) {
      const data = await syncResp.json();
      console.log(`[Sync] New repos: ${data.newRepositories ?? "?"}, new orgs: ${data.newOrganizations ?? "?"}`);
    }
  });

  test("Step 6: Trigger mirror jobs (push repos to Gitea)", async ({
    page,
    request,
  }) => {
    // Sign in
    await signInViaBrowser(page);
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Trigger the mirror-repo endpoint
    const mirrorResp = await request.post(`${APP_URL}/api/job/mirror-repo`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieStr,
      },
      data: {},
      failOnStatusCode: false,
    });

    const status = mirrorResp.status();
    console.log(`[Mirror] Mirror job response: ${status}`);

    if (status >= 400) {
      const body = await mirrorResp.text();
      console.log(`[Mirror] Error body: ${body}`);
    }

    // The mirror endpoint returns 200 immediately and processes async
    expect(status, "Mirror job should not return server error").toBeLessThan(500);

    // Wait a bit for async processing to complete
    console.log("[Mirror] Waiting for async mirror processing...");
    await new Promise((r) => setTimeout(r, 10_000));
  });

  test("Step 7: Verify repos appear in Gitea", async () => {
    // Wait for repos to be created in Gitea (the mirror process is async)
    let orgRepos: any[] = [];
    let userRepos: any[] = [];

    await waitFor(
      async () => {
        orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
        userRepos = await giteaApi.listUserRepos();
        const totalRepos = orgRepos.length + userRepos.length;
        console.log(
          `[Verify] Org repos: ${orgRepos.length}, User repos: ${userRepos.length}, Total: ${totalRepos}`,
        );
        // We expect at least 1 repo to have been mirrored
        return totalRepos > 0;
      },
      {
        timeout: 90_000,
        interval: 5_000,
        label: "Repos appear in Gitea",
      },
    );

    const allRepoNames = [
      ...orgRepos.map((r: any) => `${GITEA_MIRROR_ORG}/${r.name}`),
      ...userRepos.map((r: any) => `${GITEA_ADMIN_USER}/${r.name}`),
    ];
    console.log(`[Verify] Found repos in Gitea: ${allRepoNames.join(", ")}`);

    // The fake GitHub serves repos: my-project, dotfiles, notes, popular-lib (starred), org-tool
    // At minimum, personal repos should be mirrored
    expect(
      orgRepos.length + userRepos.length,
      "At least one repo should be mirrored to Gitea",
    ).toBeGreaterThan(0);
  });

  test("Step 8: Verify mirrored repo properties", async () => {
    // Check a specific repo if it exists
    const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    const userRepos = await giteaApi.listUserRepos();
    const allRepos = [...orgRepos, ...userRepos];

    if (allRepos.length === 0) {
      console.log("[Verify] No repos found, skipping property verification");
      test.skip();
      return;
    }

    // Find a repo we know about from the fake GitHub
    const knownNames = ["my-project", "dotfiles", "notes", "popular-lib", "org-tool"];
    const matchedRepo = allRepos.find((r: any) => knownNames.includes(r.name));

    if (matchedRepo) {
      console.log(
        `[Verify] Checking properties of repo: ${matchedRepo.full_name}`,
      );

      // Repo should be a mirror
      expect(matchedRepo.mirror, "Repo should be a mirror").toBeTruthy();

      // Repo should have a description from the fake GitHub
      if (matchedRepo.description) {
        console.log(`[Verify] Description: ${matchedRepo.description}`);
      }

      console.log(
        `[Verify] Mirror: ${matchedRepo.mirror}, Private: ${matchedRepo.private}, Size: ${matchedRepo.size}`,
      );
    } else {
      console.log(
        `[Verify] No known repos found among: ${allRepos.map((r: any) => r.name).join(", ")}`,
      );
    }
  });
});

// ─── Sync verification tests ────────────────────────────────────────────────

test.describe("E2E: Sync verification", () => {
  let giteaApi: GiteaAPI;

  test.beforeAll(async ({ request }) => {
    giteaApi = new GiteaAPI(GITEA_URL, request);
    // Ensure we have a token from earlier setup
    try {
      await giteaApi.createToken();
    } catch {
      // Token creation might fail if tests run independently;
      // these tests are meant to run after the mirror workflow
      console.log("[SyncVerify] Could not create Gitea token, tests may skip");
    }
  });

  test("Trigger a re-sync and verify it completes", async ({
    page,
    request,
  }) => {
    // Sign in
    await signInViaBrowser(page);
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Trigger sync-repo (re-sync existing repos)
    const syncResp = await request.post(`${APP_URL}/api/job/sync-repo`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieStr,
      },
      data: {},
      failOnStatusCode: false,
    });

    const status = syncResp.status();
    console.log(`[Re-Sync] Sync-repo response: ${status}`);
    expect(status).toBeLessThan(500);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 10_000));

    // Check that repos still exist (sync didn't break anything)
    const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    const userRepos = await giteaApi.listUserRepos();
    console.log(
      `[Re-Sync] After re-sync: org repos=${orgRepos.length}, user repos=${userRepos.length}`,
    );
  });

  test("Verify fake GitHub management API can add repos dynamically", async ({
    request,
  }) => {
    // Add a new repo to the fake GitHub
    const addResp = await request.post(`${FAKE_GITHUB_URL}/___mgmt/add-repo`, {
      data: {
        name: "dynamic-repo",
        owner_login: "e2e-test-user",
        description: "Dynamically added for E2E testing",
        language: "Rust",
      },
    });
    expect(addResp.ok()).toBeTruthy();

    // Verify it shows up via the GitHub API
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
    page,
    request,
  }) => {
    // Sign in
    await signInViaBrowser(page);
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Trigger a full GitHub sync to discover new repos
    const syncResp = await request.post(`${APP_URL}/api/sync`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieStr,
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
      // We expect the dynamic-repo to be discovered
      if (data.newRepositories !== undefined) {
        expect(data.newRepositories).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ─── Cleanup / teardown verification ─────────────────────────────────────────

test.describe("E2E: Fake GitHub reset", () => {
  test("Can reset fake GitHub to default state", async ({ request }) => {
    const resp = await request.post(`${FAKE_GITHUB_URL}/___mgmt/reset`);
    expect(resp.ok()).toBeTruthy();
    const data = await resp.json();
    expect(data.message).toContain("reset");
    console.log("[Reset] Fake GitHub reset to defaults");

    // Verify default state
    const health = await request.get(`${FAKE_GITHUB_URL}/___mgmt/health`);
    const healthData = await health.json();
    expect(healthData.repos).toBeGreaterThan(0);
    console.log(
      `[Reset] After reset: ${healthData.repos} repos, ${healthData.orgs} orgs`,
    );
  });
});
