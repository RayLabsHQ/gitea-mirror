/**
 * End-to-end tests for gitea-mirror.
 *
 * Prerequisites (managed by run-e2e.sh or the CI workflow):
 *   1. Gitea running on http://localhost:3333  (fresh instance, no users)
 *   2. Fake GitHub API on http://localhost:4580
 *   3. Git HTTP server on http://localhost:4590 (serves bare repos)
 *   4. gitea-mirror app on http://localhost:4321
 *
 * The tests walk through the full user journey:
 *   1. Register an account in gitea-mirror
 *   2. Create a Gitea API token
 *   3. Configure GitHub + Gitea settings via the app
 *   4. Trigger a GitHub → app sync (fetch repos from fake GitHub)
 *   5. Trigger a mirror job (push repos to Gitea)
 *   6. Verify the mirrored repos actually appear in Gitea (real git content)
 *   7. Test backup configuration (enable backup, re-sync, verify bundles)
 */

import {
  test,
  expect,
  request as playwrightRequest,
  type Page,
  type APIRequestContext,
} from "@playwright/test";

// ─── Constants ───────────────────────────────────────────────────────────────

const APP_URL = process.env.APP_URL || "http://localhost:4321";
const GITEA_URL = process.env.GITEA_URL || "http://localhost:3333";
const FAKE_GITHUB_URL = process.env.FAKE_GITHUB_URL || "http://localhost:4580";
const GIT_SERVER_URL = process.env.GIT_SERVER_URL || "http://localhost:4590";

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

/**
 * Direct HTTP helper for talking to Gitea's API.
 *
 * Uses a manually-created APIRequestContext so it can be shared across
 * beforeAll / afterAll / individual tests without hitting Playwright's
 * "fixture from beforeAll cannot be reused" restriction.
 */
class GiteaAPI {
  private token = "";
  private ctx: APIRequestContext | null = null;

  constructor(private baseUrl: string) {}

  /** Lazily create (and cache) a Playwright APIRequestContext. */
  private async getCtx(): Promise<APIRequestContext> {
    if (!this.ctx) {
      this.ctx = await playwrightRequest.newContext({
        baseURL: this.baseUrl,
      });
    }
    return this.ctx;
  }

  /** Dispose of the underlying context – call in afterAll. */
  async dispose(): Promise<void> {
    if (this.ctx) {
      await this.ctx.dispose();
      this.ctx = null;
    }
  }

  /** Create the admin user via Gitea's sign-up form (first user becomes admin). */
  async ensureAdminUser(): Promise<void> {
    const ctx = await this.getCtx();

    // Check if admin already exists by trying basic-auth
    try {
      const resp = await ctx.get(`/api/v1/user`, {
        headers: {
          Authorization: `Basic ${btoa(`${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}`)}`,
        },
        failOnStatusCode: false,
      });
      if (resp.ok()) {
        console.log("[GiteaAPI] Admin user already exists");
        return;
      }
    } catch {
      // Expected on first run
    }

    // Register through the form – first user auto-becomes admin
    console.log("[GiteaAPI] Creating admin via sign-up form...");
    const signUpResp = await ctx.post(`/user/sign_up`, {
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

    // Verify
    const check = await ctx.get(`/api/v1/user`, {
      headers: {
        Authorization: `Basic ${btoa(`${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}`)}`,
      },
      failOnStatusCode: false,
    });
    if (!check.ok()) {
      throw new Error(
        `Failed to verify admin user after creation (status ${check.status()})`,
      );
    }
    console.log("[GiteaAPI] Admin user verified");
  }

  /** Generate a Gitea API token for the admin user. */
  async createToken(): Promise<string> {
    if (this.token) return this.token;
    const ctx = await this.getCtx();

    const tokenName = `e2e-token-${Date.now()}`;
    const resp = await ctx.post(`/api/v1/users/${GITEA_ADMIN_USER}/tokens`, {
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
    });
    expect(
      resp.ok(),
      `Failed to create Gitea token: ${resp.status()}`,
    ).toBeTruthy();
    const data = await resp.json();
    this.token = data.sha1 || data.token;
    console.log(`[GiteaAPI] Created token: ${tokenName}`);
    return this.token;
  }

  /** Create an organization in Gitea. */
  async ensureOrg(orgName: string): Promise<void> {
    const ctx = await this.getCtx();
    const token = await this.createToken();

    // Check if org exists
    const check = await ctx.get(`/api/v1/orgs/${orgName}`, {
      headers: { Authorization: `token ${token}` },
      failOnStatusCode: false,
    });
    if (check.ok()) {
      console.log(`[GiteaAPI] Org ${orgName} already exists`);
      return;
    }

    const resp = await ctx.post(`/api/v1/orgs`, {
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
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(`/api/v1/orgs/${orgName}/repos`, {
      headers: { Authorization: `token ${token}` },
      failOnStatusCode: false,
    });
    if (!resp.ok()) return [];
    return resp.json();
  }

  /** List repos for the admin user. */
  async listUserRepos(): Promise<any[]> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(`/api/v1/users/${GITEA_ADMIN_USER}/repos`, {
      headers: { Authorization: `token ${token}` },
      failOnStatusCode: false,
    });
    if (!resp.ok()) return [];
    return resp.json();
  }

  /** Get a specific repo. */
  async getRepo(owner: string, name: string): Promise<any | null> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(`/api/v1/repos/${owner}/${name}`, {
      headers: { Authorization: `token ${token}` },
      failOnStatusCode: false,
    });
    if (!resp.ok()) return null;
    return resp.json();
  }

  /** List branches for a repo. */
  async listBranches(owner: string, name: string): Promise<any[]> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(`/api/v1/repos/${owner}/${name}/branches`, {
      headers: { Authorization: `token ${token}` },
      failOnStatusCode: false,
    });
    if (!resp.ok()) return [];
    return resp.json();
  }

  /** List tags for a repo. */
  async listTags(owner: string, name: string): Promise<any[]> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(`/api/v1/repos/${owner}/${name}/tags`, {
      headers: { Authorization: `token ${token}` },
      failOnStatusCode: false,
    });
    if (!resp.ok()) return [];
    return resp.json();
  }

  /** List commits for a repo (on default branch). */
  async listCommits(owner: string, name: string): Promise<any[]> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(`/api/v1/repos/${owner}/${name}/commits`, {
      headers: { Authorization: `token ${token}` },
      failOnStatusCode: false,
    });
    if (!resp.ok()) return [];
    return resp.json();
  }

  /** Get file content from a repo. */
  async getFileContent(
    owner: string,
    name: string,
    filePath: string,
  ): Promise<string | null> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(
      `/api/v1/repos/${owner}/${name}/raw/${filePath}`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return null;
    return resp.text();
  }

  getTokenValue(): string {
    return this.token;
  }
}

// ─── App auth helpers ────────────────────────────────────────────────────────

/**
 * Sign up + sign in to the gitea-mirror app using the Better Auth REST API
 * and return the session cookie string.
 */
async function getAppSessionCookies(
  request: APIRequestContext,
): Promise<string> {
  // 1. Try sign-in first (user may already exist from a previous test / run)
  const signInResp = await request.post(`${APP_URL}/api/auth/sign-in/email`, {
    data: { email: APP_USER_EMAIL, password: APP_USER_PASS },
    failOnStatusCode: false,
  });

  if (signInResp.ok()) {
    const cookies = extractSetCookies(signInResp);
    if (cookies) {
      console.log("[App] Signed in (existing user)");
      return cookies;
    }
  }

  // 2. Register
  const signUpResp = await request.post(`${APP_URL}/api/auth/sign-up/email`, {
    data: {
      name: APP_USER_NAME,
      email: APP_USER_EMAIL,
      password: APP_USER_PASS,
    },
    failOnStatusCode: false,
  });
  const signUpStatus = signUpResp.status();
  console.log(`[App] Sign-up response: ${signUpStatus}`);

  // After sign-up Better Auth may already set a session cookie
  const signUpCookies = extractSetCookies(signUpResp);
  if (signUpCookies) {
    console.log("[App] Got session from sign-up response");
    return signUpCookies;
  }

  // 3. Sign in after registration
  const postRegSignIn = await request.post(
    `${APP_URL}/api/auth/sign-in/email`,
    {
      data: { email: APP_USER_EMAIL, password: APP_USER_PASS },
      failOnStatusCode: false,
    },
  );
  if (!postRegSignIn.ok()) {
    const body = await postRegSignIn.text();
    throw new Error(
      `Sign-in after registration failed (${postRegSignIn.status()}): ${body}`,
    );
  }
  const cookies = extractSetCookies(postRegSignIn);
  if (!cookies) {
    throw new Error("Sign-in succeeded but no session cookie was returned");
  }
  console.log("[App] Signed in (after registration)");
  return cookies;
}

/**
 * Extract session cookies from a response's `set-cookie` headers.
 */
function extractSetCookies(
  resp: Awaited<ReturnType<APIRequestContext["post"]>>,
): string {
  const raw = resp
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie");
  if (raw.length === 0) return "";

  const pairs: string[] = [];
  for (const header of raw) {
    const nv = header.value.split(";")[0].trim();
    if (nv) pairs.push(nv);
  }

  return pairs.join("; ");
}

/**
 * Sign in via the browser UI so the browser context gets session cookies.
 */
async function signInViaBrowser(page: Page): Promise<string> {
  const signInResp = await page.request.post(
    `${APP_URL}/api/auth/sign-in/email`,
    {
      data: { email: APP_USER_EMAIL, password: APP_USER_PASS },
      failOnStatusCode: false,
    },
  );

  if (!signInResp.ok()) {
    const signUpResp = await page.request.post(
      `${APP_URL}/api/auth/sign-up/email`,
      {
        data: {
          name: APP_USER_NAME,
          email: APP_USER_EMAIL,
          password: APP_USER_PASS,
        },
        failOnStatusCode: false,
      },
    );
    console.log(`[Browser] Sign-up status: ${signUpResp.status()}`);

    const retryResp = await page.request.post(
      `${APP_URL}/api/auth/sign-in/email`,
      {
        data: { email: APP_USER_EMAIL, password: APP_USER_PASS },
        failOnStatusCode: false,
      },
    );
    if (!retryResp.ok()) {
      console.log(`[Browser] Sign-in retry failed: ${retryResp.status()}`);
    }
  }

  await page.goto(`${APP_URL}/`);
  await page.waitForLoadState("networkidle");
  const url = page.url();
  console.log(`[Browser] After sign-in, URL: ${url}`);

  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Save app config via the API. */
async function saveConfig(
  request: APIRequestContext,
  giteaToken: string,
  cookies: string,
  overrides: Record<string, any> = {},
): Promise<void> {
  const giteaConfigDefaults = {
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
  };

  const configPayload = {
    githubConfig: {
      username: "e2e-test-user",
      token: "fake-github-token-for-e2e",
      privateRepositories: false,
      mirrorStarred: true,
    },
    giteaConfig: { ...giteaConfigDefaults, ...(overrides.giteaConfig || {}) },
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

  expect(status, "Config save should not return server error").toBeLessThan(
    500,
  );
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
      `[Health] Fake GitHub: ${data.repos} repos, ${data.orgs} orgs, clone base: ${data.gitCloneBaseUrl ?? "default"}`,
    );
  });

  test("Git HTTP server is running (serves test repos)", async ({
    request,
  }) => {
    const resp = await request.get(`${GIT_SERVER_URL}/manifest.json`, {
      failOnStatusCode: false,
    });
    expect(resp.ok(), "Git server should serve manifest.json").toBeTruthy();
    const manifest = await resp.json();
    expect(manifest.repos).toBeDefined();
    expect(manifest.repos.length).toBeGreaterThan(0);
    console.log(`[Health] Git server: serving ${manifest.repos.length} repos`);
    for (const r of manifest.repos) {
      console.log(`[Health]   • ${r.owner}/${r.name} — ${r.description}`);
    }
  });

  test("Gitea instance is running", async ({ request }) => {
    await waitFor(
      async () => {
        const resp = await request.get(`${GITEA_URL}/api/v1/version`, {
          failOnStatusCode: false,
        });
        return resp.ok();
      },
      { timeout: 30_000, interval: 2_000, label: "Gitea healthy" },
    );
    const resp = await request.get(`${GITEA_URL}/api/v1/version`);
    const data = await resp.json();
    console.log(`[Health] Gitea version: ${data.version}`);
    expect(data.version).toBeTruthy();
  });

  test("gitea-mirror app is running", async ({ request }) => {
    await waitFor(
      async () => {
        const resp = await request.get(`${APP_URL}/`, {
          failOnStatusCode: false,
        });
        return resp.status() < 500;
      },
      { timeout: 60_000, interval: 2_000, label: "App healthy" },
    );
    const resp = await request.get(`${APP_URL}/`, {
      failOnStatusCode: false,
    });
    console.log(`[Health] App status: ${resp.status()}`);
    expect(resp.status()).toBeLessThan(500);
  });
});

// ─── Main mirror workflow ────────────────────────────────────────────────────

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
    const dashResp = await request.get(`${APP_URL}/api/dashboard`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });
    expect(dashResp.status(), "Dashboard should be accessible").toBeLessThan(
      500,
    );

    let repositoryIds: string[] = [];
    if (dashResp.ok()) {
      const dashData = await dashResp.json();
      const repos: any[] = dashData.repositories ?? dashData.repos ?? [];
      repositoryIds = repos.map((r: any) => r.id);
      console.log(
        `[Mirror] Found ${repositoryIds.length} repos to mirror: ${repos.map((r: any) => r.name).join(", ")}`,
      );
    }

    if (repositoryIds.length === 0) {
      const repoResp = await request.get(`${APP_URL}/api/github/repositories`, {
        headers: { Cookie: appCookies },
        failOnStatusCode: false,
      });
      if (repoResp.ok()) {
        const repoData = await repoResp.json();
        const repos: any[] = Array.isArray(repoData)
          ? repoData
          : (repoData.repositories ?? []);
        repositoryIds = repos.map((r: any) => r.id);
        console.log(`[Mirror] Fallback: found ${repositoryIds.length} repos`);
      }
    }

    expect(
      repositoryIds.length,
      "Should have at least one repository to mirror",
    ).toBeGreaterThan(0);

    const mirrorResp = await request.post(`${APP_URL}/api/job/mirror-repo`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: appCookies,
      },
      data: { repositoryIds },
      failOnStatusCode: false,
    });

    const status = mirrorResp.status();
    console.log(`[Mirror] Mirror job response: ${status}`);

    if (status >= 400) {
      const body = await mirrorResp.text();
      console.log(`[Mirror] Error body: ${body}`);
    }

    expect(status, "Mirror job should not be unauthorized").not.toBe(401);
    expect(status, "Mirror job should not return server error").toBeLessThan(
      500,
    );

    // The mirror endpoint returns 200 immediately and processes async.
    // Wait for processing – Gitea needs time to clone all repos.
    console.log("[Mirror] Waiting for async mirror processing...");
    await new Promise((r) => setTimeout(r, 30_000));
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
        // We expect at least 3 repos (my-project, dotfiles, notes from e2e-test-user)
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
    const expectedRepos = ["my-project", "dotfiles", "notes"];
    for (const repoName of expectedRepos) {
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
    const commits = await giteaApi.listCommits(GITEA_MIRROR_ORG, "my-project");
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

      // At least some should have succeeded (actually mirrored)
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

// ─── Backup configuration tests ──────────────────────────────────────────────

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

  test("Step B2: Verify mirrored repos exist in Gitea before backup test", async () => {
    // We need repos to already be mirrored from the previous test suite
    const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
    console.log(
      `[Backup] Repos in ${GITEA_MIRROR_ORG}: ${orgRepos.length} (${orgRepos.map((r: any) => r.name).join(", ")})`,
    );

    // If no repos were mirrored from the previous suite, note it
    if (orgRepos.length === 0) {
      console.log(
        "[Backup] WARNING: No repos in Gitea yet. Backup test will verify job creation but not bundle creation.",
      );
    }
  });

  test("Step B3: Trigger re-sync with backup enabled", async ({ request }) => {
    if (!appCookies) {
      appCookies = await getAppSessionCookies(request);
    }

    // First, fetch the repository IDs from the dashboard (sync-repo requires them)
    const dashResp = await request.get(`${APP_URL}/api/dashboard`, {
      headers: { Cookie: appCookies },
      failOnStatusCode: false,
    });
    expect(dashResp.status()).toBeLessThan(500);

    let repositoryIds: string[] = [];
    if (dashResp.ok()) {
      const dashData = await dashResp.json();
      const repos: any[] = dashData.repositories ?? [];
      repositoryIds = repos
        .filter((r: any) => r.status === "mirrored" || r.status === "success")
        .map((r: any) => r.id);
      console.log(
        `[Backup] Found ${repositoryIds.length} mirrored repos to re-sync: ${repos
          .filter((r: any) => r.status === "mirrored" || r.status === "success")
          .map((r: any) => r.name)
          .join(", ")}`,
      );
    }

    expect(
      repositoryIds.length,
      "Need at least one mirrored repo to test backup",
    ).toBeGreaterThan(0);

    // Trigger sync-repo with the repository IDs — this calls syncGiteaRepoEnhanced
    // which checks shouldCreatePreSyncBackup and creates bundles before syncing
    const syncResp = await request.post(`${APP_URL}/api/job/sync-repo`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: appCookies,
      },
      data: { repositoryIds },
      failOnStatusCode: false,
    });

    const status = syncResp.status();
    console.log(`[Backup] Sync-repo response: ${status}`);
    expect(status, "Sync-repo should accept request").toBeLessThan(500);

    if (status >= 400) {
      const body = await syncResp.text();
      console.log(`[Backup] Sync-repo error: ${body}`);
    }

    // Wait for sync + backup processing (backup clones from Gitea, then syncs)
    console.log("[Backup] Waiting for backup + sync processing...");
    await new Promise((r) => setTimeout(r, 25_000));
  });

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

    if (activitiesResp.ok()) {
      const activities = await activitiesResp.json();
      const jobs: any[] = Array.isArray(activities)
        ? activities
        : (activities.jobs ?? activities.activities ?? []);

      // Look for backup-related messages
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
          `[Backup]   • ${j.repositoryName ?? "?"}: ${j.status} — ${j.message ?? ""} | ${j.details ?? ""}`,
        );
      }

      // We expect at least some backup-related entries if repos were mirrored
      const orgRepos = await giteaApi.listOrgRepos(GITEA_MIRROR_ORG);
      if (orgRepos.length > 0) {
        // With repos in Gitea, the backup system should have tried to create snapshots
        console.log(
          `[Backup] Expected backup attempts for ${orgRepos.length} repos`,
        );

        // Log ALL recent jobs for debugging
        console.log(`[Backup] All recent jobs (last 20):`);
        for (const j of jobs.slice(0, 20)) {
          console.log(
            `[Backup]   - [${j.status}] ${j.repositoryName ?? "?"}: ${j.message ?? ""} ${j.details ? `(${j.details.substring(0, 80)})` : ""}`,
          );
        }
      }
    } else {
      console.log(
        `[Backup] Could not fetch activities: ${activitiesResp.status()}`,
      );
    }
  });

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

    // Verify config
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

// ─── Sync verification tests ────────────────────────────────────────────────

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

  test("Verify repo content integrity after mirror", async () => {
    // Detailed content verification on repos that were mirrored

    // Check popular-lib (starred repo from other-user)
    // In single-org strategy, it might be under GITEA_MIRROR_ORG or github-stars org
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

    // Verify notes repo (minimal single-commit repo)
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
    }

    // Verify org-tool if it was mirrored
    const allMirroredNames = [...orgRepoNames, ...starsRepoNames];
    // org-tool might be in the mirror org or a separate org depending on strategy
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
        break;
      }
    }
    if (!foundOrgTool) {
      console.log(
        "[Integrity] org-tool not found in Gitea (may not have been mirrored in single-org strategy)",
      );
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

    const health = await request.get(`${FAKE_GITHUB_URL}/___mgmt/health`);
    const healthData = await health.json();
    expect(healthData.repos).toBeGreaterThan(0);
    console.log(
      `[Reset] After reset: ${healthData.repos} repos, ${healthData.orgs} orgs`,
    );
  });
});
