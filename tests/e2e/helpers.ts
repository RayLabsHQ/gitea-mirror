/**
 * Shared helpers for E2E tests.
 *
 * Exports constants, the GiteaAPI wrapper, auth helpers (sign-up / sign-in),
 * the saveConfig helper, and a generic waitFor polling utility.
 */

import {
  expect,
  request as playwrightRequest,
  type Page,
  type APIRequestContext,
} from "@playwright/test";

// ─── Constants ───────────────────────────────────────────────────────────────

export const APP_URL = process.env.APP_URL || "http://localhost:4321";
export const GITEA_URL = process.env.GITEA_URL || "http://localhost:3333";
export const FAKE_GITHUB_URL =
  process.env.FAKE_GITHUB_URL || "http://localhost:4580";
export const GIT_SERVER_URL =
  process.env.GIT_SERVER_URL || "http://localhost:4590";

export const GITEA_ADMIN_USER = "e2e_admin";
export const GITEA_ADMIN_PASS = "e2eAdminPass123!";
export const GITEA_ADMIN_EMAIL = "admin@e2e-test.local";

export const APP_USER_EMAIL = "e2e@test.local";
export const APP_USER_PASS = "E2eTestPass123!";
export const APP_USER_NAME = "e2e-tester";

export const GITEA_MIRROR_ORG = "github-mirrors";

// ─── waitFor ─────────────────────────────────────────────────────────────────

/** Retry a function until it returns truthy or timeout is reached. */
export async function waitFor(
  fn: () => Promise<boolean>,
  {
    timeout = 60_000,
    interval = 2_000,
    label = "condition",
  }: { timeout?: number; interval?: number; label?: string } = {},
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

// ─── GiteaAPI ────────────────────────────────────────────────────────────────

/**
 * Direct HTTP helper for talking to Gitea's API.
 *
 * Uses a manually-created APIRequestContext so it can be shared across
 * beforeAll / afterAll / individual tests without hitting Playwright's
 * "fixture from beforeAll cannot be reused" restriction.
 */
export class GiteaAPI {
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
  async listCommits(
    owner: string,
    name: string,
    opts?: { sha?: string; limit?: number },
  ): Promise<any[]> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const params = new URLSearchParams();
    if (opts?.sha) params.set("sha", opts.sha);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const resp = await ctx.get(
      `/api/v1/repos/${owner}/${name}/commits${qs}`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return [];
    return resp.json();
  }

  /** Get a single branch (includes the commit SHA). */
  async getBranch(
    owner: string,
    name: string,
    branch: string,
  ): Promise<any | null> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(
      `/api/v1/repos/${owner}/${name}/branches/${branch}`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return null;
    return resp.json();
  }

  /** Get file content from a repo. */
  async getFileContent(
    owner: string,
    name: string,
    filePath: string,
    ref?: string,
  ): Promise<string | null> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const resp = await ctx.get(
      `/api/v1/repos/${owner}/${name}/raw/${filePath}${refQuery}`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return null;
    return resp.text();
  }

  /** Get a commit by SHA. */
  async getCommit(
    owner: string,
    name: string,
    sha: string,
  ): Promise<any | null> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.get(
      `/api/v1/repos/${owner}/${name}/git/commits/${sha}`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    if (!resp.ok()) return null;
    return resp.json();
  }

  /** Trigger mirror sync for a repo via the Gitea API directly. */
  async triggerMirrorSync(owner: string, name: string): Promise<boolean> {
    const ctx = await this.getCtx();
    const token = await this.createToken();
    const resp = await ctx.post(
      `/api/v1/repos/${owner}/${name}/mirror-sync`,
      {
        headers: { Authorization: `token ${token}` },
        failOnStatusCode: false,
      },
    );
    return resp.ok() || resp.status() === 200;
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
export async function getAppSessionCookies(
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
export function extractSetCookies(
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
export async function signInViaBrowser(page: Page): Promise<string> {
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

// ─── Config helper ───────────────────────────────────────────────────────────

/** Save app config via the API. */
export async function saveConfig(
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

// ─── Dashboard / repo helpers ────────────────────────────────────────────────

/**
 * Fetch the list of repository IDs from the app's dashboard API.
 * Optionally filter to repos with a given status.
 */
export async function getRepositoryIds(
  request: APIRequestContext,
  cookies: string,
  opts?: { status?: string },
): Promise<{ ids: string[]; repos: any[] }> {
  const dashResp = await request.get(`${APP_URL}/api/dashboard`, {
    headers: { Cookie: cookies },
    failOnStatusCode: false,
  });
  if (!dashResp.ok()) return { ids: [], repos: [] };

  const dashData = await dashResp.json();
  const repos: any[] = dashData.repositories ?? dashData.repos ?? [];

  const filtered = opts?.status
    ? repos.filter((r: any) => r.status === opts.status)
    : repos;

  return {
    ids: filtered.map((r: any) => r.id),
    repos: filtered,
  };
}

/**
 * Trigger mirror jobs for the given repository IDs via the app API,
 * then wait for a specified delay for async processing.
 */
export async function triggerMirrorJobs(
  request: APIRequestContext,
  cookies: string,
  repositoryIds: string[],
  waitMs = 30_000,
): Promise<number> {
  const mirrorResp = await request.post(`${APP_URL}/api/job/mirror-repo`, {
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
    },
    data: { repositoryIds },
    failOnStatusCode: false,
  });

  const status = mirrorResp.status();
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return status;
}

/**
 * Trigger sync-repo (re-sync already-mirrored repos) for the given
 * repository IDs, then wait for processing.
 */
export async function triggerSyncRepo(
  request: APIRequestContext,
  cookies: string,
  repositoryIds: string[],
  waitMs = 25_000,
): Promise<number> {
  const syncResp = await request.post(`${APP_URL}/api/job/sync-repo`, {
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
    },
    data: { repositoryIds },
    failOnStatusCode: false,
  });

  const status = syncResp.status();
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return status;
}
