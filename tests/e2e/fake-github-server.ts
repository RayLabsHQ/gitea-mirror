/**
 * Fake GitHub API server for E2E testing.
 *
 * Implements the subset of the GitHub REST API that gitea-mirror actually uses:
 *   - GET  /user                           (authenticated user)
 *   - GET  /user/repos                     (user repositories)
 *   - GET  /user/starred                   (starred repositories)
 *   - GET  /user/orgs                      (user organizations)
 *   - GET  /repos/:owner/:repo             (single repo)
 *   - GET  /repos/:owner/:repo/branches    (branches)
 *   - GET  /repos/:owner/:repo/git/refs    (git refs)
 *   - GET  /repos/:owner/:repo/issues      (issues)
 *   - GET  /repos/:owner/:repo/pulls       (pull requests)
 *   - GET  /repos/:owner/:repo/releases    (releases)
 *   - GET  /repos/:owner/:repo/labels      (labels)
 *   - GET  /repos/:owner/:repo/milestones  (milestones)
 *   - GET  /orgs/:org                      (org details)
 *   - GET  /orgs/:org/repos                (org repos)
 *   - GET  /user/memberships/orgs/:org     (org membership)
 *   - GET  /rate_limit                     (rate limit status)
 *
 * All data is served from an in-memory store that can be seeded via the
 * management API:
 *   - POST /___mgmt/seed          (replace entire store)
 *   - POST /___mgmt/add-repo      (add a single repo)
 *   - POST /___mgmt/add-org       (add an organization)
 *   - POST /___mgmt/reset         (reset to defaults)
 *   - GET  /___mgmt/health        (liveness check)
 *
 * Start:
 *   npx tsx tests/e2e/fake-github-server.ts          # default port 4580
 *   PORT=4580 npx tsx tests/e2e/fake-github-server.ts
 */

import http from "node:http";
import { URL } from "node:url";

// ─── Clone URL Configuration ─────────────────────────────────────────────────
// When GIT_SERVER_URL is set, clone_url fields will point to a real git HTTP
// server (e.g. http://git-server) so Gitea can actually clone the repos.
// When unset, clone_url uses the unreachable https://fake-github.test/ default.
let GIT_CLONE_BASE_URL =
  process.env.GIT_SERVER_URL || "https://fake-github.test";
// For html_url we always use the fake domain (it's cosmetic / not cloned)
const HTML_BASE_URL = "https://fake-github.test";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FakeUser {
  login: string;
  id: number;
  avatar_url: string;
  type: "User";
  name: string;
  email: string;
}

interface FakeRepo {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    id: number;
    type: "User" | "Organization";
    avatar_url: string;
  };
  private: boolean;
  html_url: string;
  clone_url: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  visibility: "public" | "private";
  default_branch: string;
  language: string | null;
  size: number;
  has_issues: boolean;
  has_wiki: boolean;
  created_at: string;
  updated_at: string;
  pushed_at: string;
}

interface FakeOrg {
  login: string;
  id: number;
  avatar_url: string;
  description: string;
  public_repos: number;
  total_private_repos: number;
}

interface FakeLabel {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface FakeIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: FakeLabel[];
  user: { login: string; id: number };
  assignees: { login: string; id: number }[];
  comments: number;
  created_at: string;
  updated_at: string;
}

interface FakePullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string; id: number };
  labels: FakeLabel[];
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
}

interface FakeRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  assets: {
    id: number;
    name: string;
    size: number;
    browser_download_url: string;
  }[];
}

interface FakeBranch {
  name: string;
  commit: { sha: string; url: string };
  protected: boolean;
}

interface FakeMilestone {
  id: number;
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  due_on: string | null;
  created_at: string;
  updated_at: string;
}

interface FakeRepoData {
  repo: FakeRepo;
  branches: FakeBranch[];
  issues: FakeIssue[];
  pullRequests: FakePullRequest[];
  releases: FakeRelease[];
  labels: FakeLabel[];
  milestones: FakeMilestone[];
}

interface Store {
  user: FakeUser;
  repos: Map<string, FakeRepoData>; // keyed by "owner/name"
  starredRepoKeys: Set<string>;
  orgs: Map<string, FakeOrg>;
  orgRepoKeys: Map<string, string[]>; // org login -> repo keys
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let nextId = 1000;
function genId(): number {
  return nextId++;
}

function now(): string {
  return new Date().toISOString();
}

function makeRepo(
  overrides: Partial<FakeRepo> & { name: string; owner_login: string },
): FakeRepo {
  const ownerLogin = overrides.owner_login;
  const ownerType = overrides.owner?.type ?? "User";
  const ts = now();
  return {
    id: overrides.id ?? genId(),
    name: overrides.name,
    full_name: `${ownerLogin}/${overrides.name}`,
    owner: {
      login: ownerLogin,
      id: overrides.owner?.id ?? genId(),
      type: ownerType,
      avatar_url:
        overrides.owner?.avatar_url ??
        `https://fake-github.test/avatars/${ownerLogin}`,
    },
    private: overrides.private ?? false,
    html_url: `${HTML_BASE_URL}/${ownerLogin}/${overrides.name}`,
    clone_url:
      overrides.clone_url ??
      `${GIT_CLONE_BASE_URL}/${ownerLogin}/${overrides.name}.git`,
    description: overrides.description ?? `Fake repo ${overrides.name}`,
    fork: overrides.fork ?? false,
    archived: overrides.archived ?? false,
    disabled: overrides.disabled ?? false,
    visibility: overrides.visibility ?? "public",
    default_branch: overrides.default_branch ?? "main",
    language: overrides.language ?? "TypeScript",
    size: overrides.size ?? 128,
    has_issues: overrides.has_issues ?? true,
    has_wiki: overrides.has_wiki ?? true,
    created_at: overrides.created_at ?? ts,
    updated_at: overrides.updated_at ?? ts,
    pushed_at: overrides.pushed_at ?? ts,
  };
}

function makeRepoData(repo: FakeRepo): FakeRepoData {
  const sha = "a".repeat(40);
  return {
    repo,
    branches: [
      { name: repo.default_branch, commit: { sha, url: "" }, protected: false },
    ],
    issues: [],
    pullRequests: [],
    releases: [],
    labels: [
      {
        id: genId(),
        name: "bug",
        color: "d73a4a",
        description: "Something isn't working",
      },
      {
        id: genId(),
        name: "enhancement",
        color: "a2eeef",
        description: "New feature",
      },
    ],
    milestones: [],
  };
}

function defaultStore(): Store {
  const user: FakeUser = {
    login: "e2e-test-user",
    id: 1,
    avatar_url: "https://fake-github.test/avatars/e2e-test-user",
    type: "User",
    name: "E2E Test User",
    email: "e2e@test.local",
  };

  const repos = new Map<string, FakeRepoData>();
  const starredRepoKeys = new Set<string>();
  const orgs = new Map<string, FakeOrg>();
  const orgRepoKeys = new Map<string, string[]>();

  // Create a few personal repos
  for (const repoName of ["my-project", "dotfiles", "notes"]) {
    const repo = makeRepo({ name: repoName, owner_login: user.login });
    repos.set(`${user.login}/${repoName}`, makeRepoData(repo));
  }

  // Add an issue and PR to my-project
  const myProject = repos.get(`${user.login}/my-project`)!;
  myProject.issues.push({
    id: genId(),
    number: 1,
    title: "Initial issue for testing",
    body: "This is a test issue created by the fake GitHub server.",
    state: "open",
    labels: [myProject.labels[0]],
    user: { login: user.login, id: user.id },
    assignees: [{ login: user.login, id: user.id }],
    comments: 0,
    created_at: now(),
    updated_at: now(),
  });
  myProject.pullRequests.push({
    id: genId(),
    number: 2,
    title: "Add README",
    body: "Adding a README file.\n\nCloses #1",
    state: "open",
    merged: false,
    merge_commit_sha: null,
    head: { ref: "add-readme", sha: "b".repeat(40) },
    base: { ref: "main", sha: "a".repeat(40) },
    user: { login: user.login, id: user.id },
    labels: [],
    commits: 1,
    additions: 10,
    deletions: 0,
    changed_files: 1,
    created_at: now(),
    updated_at: now(),
  });
  myProject.releases.push({
    id: genId(),
    tag_name: "v1.0.0",
    name: "v1.0.0",
    body: "Initial release",
    draft: false,
    prerelease: false,
    created_at: now(),
    published_at: now(),
    assets: [],
  });
  myProject.milestones.push({
    id: genId(),
    number: 1,
    title: "v1.0",
    description: "First milestone",
    state: "open",
    due_on: null,
    created_at: now(),
    updated_at: now(),
  });

  // Create a starred repo from another user
  const starredRepo = makeRepo({
    name: "popular-lib",
    owner_login: "other-user",
    description: "A popular library that we starred",
  });
  const starredKey = "other-user/popular-lib";
  repos.set(starredKey, makeRepoData(starredRepo));
  starredRepoKeys.add(starredKey);

  // Create an organization with a repo
  const orgLogin = "test-org";
  orgs.set(orgLogin, {
    login: orgLogin,
    id: genId(),
    avatar_url: `https://fake-github.test/avatars/${orgLogin}`,
    description: "A test organization",
    public_repos: 1,
    total_private_repos: 0,
  });
  const orgRepo = makeRepo({
    name: "org-tool",
    owner_login: orgLogin,
    owner: {
      login: orgLogin,
      id: genId(),
      type: "Organization",
      avatar_url: "",
    },
  });
  const orgRepoKey = `${orgLogin}/org-tool`;
  repos.set(orgRepoKey, makeRepoData(orgRepo));
  orgRepoKeys.set(orgLogin, [orgRepoKey]);

  return { user, repos, starredRepoKeys, orgs, orgRepoKeys };
}

// ─── Routing ─────────────────────────────────────────────────────────────────

let store: Store = defaultStore();

type RouteHandler = (
  params: Record<string, string>,
  query: URLSearchParams,
  body: any,
) => { status: number; body: any; headers?: Record<string, string> };

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function route(method: string, path: string, handler: RouteHandler): Route {
  // Convert :param segments to named capture groups
  const paramNames: string[] = [];
  const patternStr = path.replace(/:([a-zA-Z_]+)/g, (_m, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return {
    method,
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    handler,
  };
}

function paginate<T>(items: T[], query: URLSearchParams): T[] {
  const page = parseInt(query.get("page") || "1", 10);
  const perPage = Math.min(parseInt(query.get("per_page") || "30", 10), 100);
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function rateLimitHeaders(): Record<string, string> {
  const resetTime = Math.floor(Date.now() / 1000) + 3600;
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-used": "1",
    "x-ratelimit-reset": resetTime.toString(),
  };
}

const routes: Route[] = [
  // ── Authenticated user ──────────────────────────────────────────
  route("GET", "/user", () => ({
    status: 200,
    body: store.user,
    headers: rateLimitHeaders(),
  })),

  // ── User repos ──────────────────────────────────────────────────
  route("GET", "/user/repos", (_p, query) => {
    const userRepos = Array.from(store.repos.values())
      .filter((rd) => rd.repo.owner.login === store.user.login)
      .map((rd) => rd.repo);
    return {
      status: 200,
      body: paginate(userRepos, query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Starred repos ───────────────────────────────────────────────
  route("GET", "/user/starred", (_p, query) => {
    const starred = Array.from(store.starredRepoKeys)
      .map((key) => store.repos.get(key)?.repo)
      .filter(Boolean);
    return {
      status: 200,
      body: paginate(starred as FakeRepo[], query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── User organizations ──────────────────────────────────────────
  route("GET", "/user/orgs", (_p, query) => {
    const orgList = Array.from(store.orgs.values()).map((o) => ({
      login: o.login,
      id: o.id,
      avatar_url: o.avatar_url,
      description: o.description,
    }));
    return {
      status: 200,
      body: paginate(orgList, query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Org membership ──────────────────────────────────────────────
  route("GET", "/user/memberships/orgs/:org", (params) => {
    const org = store.orgs.get(params.org);
    if (!org) return { status: 404, body: { message: "Not Found" } };
    return {
      status: 200,
      body: {
        url: `https://fake-github.test/user/memberships/orgs/${params.org}`,
        state: "active",
        role: "admin",
        organization: org,
        user: store.user,
      },
      headers: rateLimitHeaders(),
    };
  }),

  // ── Single repo ─────────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo", (params) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    return { status: 200, body: rd.repo, headers: rateLimitHeaders() };
  }),

  // ── Repo branches ───────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/branches", (params, query) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    return {
      status: 200,
      body: paginate(rd.branches, query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Git refs ────────────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/git/refs", (params) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    const refs = rd.branches.map((b) => ({
      ref: `refs/heads/${b.name}`,
      node_id: "",
      url: "",
      object: { sha: b.commit.sha, type: "commit", url: "" },
    }));
    return { status: 200, body: refs, headers: rateLimitHeaders() };
  }),

  // ── Issues ──────────────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/issues", (params, query) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    // GitHub's issues endpoint also returns PRs; we filter them out
    // unless explicitly requested (the app uses separate endpoints)
    return {
      status: 200,
      body: paginate(rd.issues, query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Issue comments ──────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/issues/:issue_number/comments", () => {
    // Return empty comments for simplicity
    return { status: 200, body: [], headers: rateLimitHeaders() };
  }),

  // ── Pull requests ───────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/pulls", (params, query) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    return {
      status: 200,
      body: paginate(rd.pullRequests, query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Single pull request detail ──────────────────────────────────
  route("GET", "/repos/:owner/:repo/pulls/:pull_number", (params) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    const pr = rd.pullRequests.find(
      (p) => p.number === parseInt(params.pull_number, 10),
    );
    if (!pr) return { status: 404, body: { message: "Not Found" } };
    return { status: 200, body: pr, headers: rateLimitHeaders() };
  }),

  // ── Pull request commits ────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/pulls/:pull_number/commits", () => {
    return {
      status: 200,
      body: [
        {
          sha: "c".repeat(40),
          commit: {
            message: "test commit",
            author: { name: "Test", date: now() },
          },
          author: { login: "e2e-test-user" },
        },
      ],
      headers: rateLimitHeaders(),
    };
  }),

  // ── Pull request files ──────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/pulls/:pull_number/files", () => {
    return {
      status: 200,
      body: [
        {
          sha: "d".repeat(40),
          filename: "README.md",
          status: "added",
          additions: 10,
          deletions: 0,
          changes: 10,
        },
      ],
      headers: rateLimitHeaders(),
    };
  }),

  // ── Releases ────────────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/releases", (params, query) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    return {
      status: 200,
      body: paginate(rd.releases, query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Release assets ──────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/releases/:release_id/assets", () => {
    return { status: 200, body: [], headers: rateLimitHeaders() };
  }),

  // ── Labels ──────────────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/labels", (params, query) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    return {
      status: 200,
      body: paginate(rd.labels, query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Milestones ──────────────────────────────────────────────────
  route("GET", "/repos/:owner/:repo/milestones", (params, query) => {
    const key = `${params.owner}/${params.repo}`;
    const rd = store.repos.get(key);
    if (!rd) return { status: 404, body: { message: "Not Found" } };
    return {
      status: 200,
      body: paginate(rd.milestones, query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Organization details ────────────────────────────────────────
  route("GET", "/orgs/:org", (params) => {
    const org = store.orgs.get(params.org);
    if (!org) return { status: 404, body: { message: "Not Found" } };
    return { status: 200, body: org, headers: rateLimitHeaders() };
  }),

  // ── Organization repos ──────────────────────────────────────────
  route("GET", "/orgs/:org/repos", (params, query) => {
    const keys = store.orgRepoKeys.get(params.org) ?? [];
    const orgRepos = keys.map((k) => store.repos.get(k)?.repo).filter(Boolean);
    return {
      status: 200,
      body: paginate(orgRepos as FakeRepo[], query),
      headers: rateLimitHeaders(),
    };
  }),

  // ── Rate limit ──────────────────────────────────────────────────
  route("GET", "/rate_limit", () => {
    const resetTime = Math.floor(Date.now() / 1000) + 3600;
    return {
      status: 200,
      body: {
        resources: {
          core: { limit: 5000, remaining: 4999, reset: resetTime, used: 1 },
          search: { limit: 30, remaining: 30, reset: resetTime, used: 0 },
        },
        rate: { limit: 5000, remaining: 4999, reset: resetTime, used: 1 },
      },
      headers: rateLimitHeaders(),
    };
  }),

  // ─── Management API ─────────────────────────────────────────────
  route("GET", "/___mgmt/health", () => ({
    status: 200,
    body: {
      status: "ok",
      repos: store.repos.size,
      orgs: store.orgs.size,
      starredCount: store.starredRepoKeys.size,
      gitCloneBaseUrl: GIT_CLONE_BASE_URL,
    },
  })),

  // Set the git clone base URL at runtime (for when the git-server starts later)
  route("POST", "/___mgmt/set-clone-url", (_p, _q, body) => {
    if (!body || !body.url) {
      return { status: 400, body: { message: "url is required" } };
    }
    const oldUrl = GIT_CLONE_BASE_URL;
    GIT_CLONE_BASE_URL = body.url.replace(/\/$/, "");

    // Update clone_url on all existing repos
    for (const [key, rd] of store.repos.entries()) {
      const owner = rd.repo.owner.login;
      const name = rd.repo.name;
      rd.repo.clone_url = `${GIT_CLONE_BASE_URL}/${owner}/${name}.git`;
    }

    console.log(
      `[FakeGitHub] Clone base URL changed: ${oldUrl} → ${GIT_CLONE_BASE_URL}`,
    );
    return {
      status: 200,
      body: {
        message: "Clone URL base updated",
        oldUrl,
        newUrl: GIT_CLONE_BASE_URL,
        reposUpdated: store.repos.size,
      },
    };
  }),

  route("POST", "/___mgmt/reset", () => {
    nextId = 1000;
    store = defaultStore();
    return {
      status: 200,
      body: {
        message: "Store reset to defaults",
        gitCloneBaseUrl: GIT_CLONE_BASE_URL,
      },
    };
  }),

  route("POST", "/___mgmt/add-repo", (_p, _q, body) => {
    if (!body || !body.name || !body.owner_login) {
      return {
        status: 400,
        body: { message: "name and owner_login required" },
      };
    }
    const repo = makeRepo(body);
    const key = repo.full_name;
    const repoData = makeRepoData(repo);

    // Merge in optional pre-populated data
    if (body.issues && Array.isArray(body.issues)) {
      repoData.issues = body.issues;
    }
    if (body.pullRequests && Array.isArray(body.pullRequests)) {
      repoData.pullRequests = body.pullRequests;
    }
    if (body.releases && Array.isArray(body.releases)) {
      repoData.releases = body.releases;
    }
    if (body.labels && Array.isArray(body.labels)) {
      repoData.labels = body.labels;
    }
    if (body.milestones && Array.isArray(body.milestones)) {
      repoData.milestones = body.milestones;
    }
    if (body.branches && Array.isArray(body.branches)) {
      repoData.branches = body.branches;
    }

    store.repos.set(key, repoData);

    if (body.starred) {
      store.starredRepoKeys.add(key);
    }

    // If the owner is an org, track the repo under that org
    if (repo.owner.type === "Organization") {
      const orgKeys = store.orgRepoKeys.get(repo.owner.login) ?? [];
      orgKeys.push(key);
      store.orgRepoKeys.set(repo.owner.login, orgKeys);
    }

    return { status: 201, body: { message: "Repo added", key } };
  }),

  route("POST", "/___mgmt/add-org", (_p, _q, body) => {
    if (!body || !body.login) {
      return { status: 400, body: { message: "login required" } };
    }
    const org: FakeOrg = {
      login: body.login,
      id: body.id ?? genId(),
      avatar_url:
        body.avatar_url ?? `https://fake-github.test/avatars/${body.login}`,
      description: body.description ?? "",
      public_repos: body.public_repos ?? 0,
      total_private_repos: body.total_private_repos ?? 0,
    };
    store.orgs.set(org.login, org);
    if (!store.orgRepoKeys.has(org.login)) {
      store.orgRepoKeys.set(org.login, []);
    }
    return { status: 201, body: { message: "Org added", login: org.login } };
  }),

  route("POST", "/___mgmt/seed", (_p, _q, body) => {
    if (!body) {
      return { status: 400, body: { message: "Body required" } };
    }
    nextId = 1000;
    store = defaultStore();

    // Override user if provided
    if (body.user) {
      store.user = { ...store.user, ...body.user };
    }

    // Clear default repos if custom repos are provided
    if (body.repos && Array.isArray(body.repos)) {
      store.repos.clear();
      store.starredRepoKeys.clear();
      for (const r of body.repos) {
        const repo = makeRepo(r);
        const rd = makeRepoData(repo);
        if (r.issues) rd.issues = r.issues;
        if (r.pullRequests) rd.pullRequests = r.pullRequests;
        if (r.releases) rd.releases = r.releases;
        if (r.labels) rd.labels = r.labels;
        if (r.milestones) rd.milestones = r.milestones;
        if (r.branches) rd.branches = r.branches;
        store.repos.set(repo.full_name, rd);
        if (r.starred) store.starredRepoKeys.add(repo.full_name);
      }
    }

    // Clear/set orgs if provided
    if (body.orgs && Array.isArray(body.orgs)) {
      store.orgs.clear();
      store.orgRepoKeys.clear();
      for (const o of body.orgs) {
        const org: FakeOrg = {
          login: o.login,
          id: o.id ?? genId(),
          avatar_url: o.avatar_url ?? "",
          description: o.description ?? "",
          public_repos: o.public_repos ?? 0,
          total_private_repos: o.total_private_repos ?? 0,
        };
        store.orgs.set(org.login, org);
        store.orgRepoKeys.set(org.login, []);
      }
    }

    return {
      status: 200,
      body: {
        message: "Store seeded",
        repos: store.repos.size,
        orgs: store.orgs.size,
      },
    };
  }),
];

// ─── Server ──────────────────────────────────────────────────────────────────

function matchRoute(
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  // Try matching the pathname directly first
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = pathname.match(r.pattern);
    if (match) {
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { route: r, params };
    }
  }

  // If no match, try stripping /api/v3 prefix (Octokit adds this for custom baseUrl)
  const apiV3Prefix = "/api/v3";
  if (pathname.startsWith(apiV3Prefix)) {
    const strippedPath = pathname.slice(apiV3Prefix.length) || "/";
    for (const r of routes) {
      if (r.method !== method) continue;
      const match = strippedPath.match(r.pattern);
      if (match) {
        const params: Record<string, string> = {};
        r.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        return { route: r, params };
      }
    }
  }

  return null;
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

const PORT = parseInt(
  process.env.PORT || process.env.FAKE_GITHUB_PORT || "4580",
  10,
);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const method = (req.method || "GET").toUpperCase();
  const pathname = url.pathname;

  // CORS for local development
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept",
  );

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const matched = matchRoute(method, pathname);

  if (!matched) {
    // Log unmatched requests for debugging
    console.warn(`[FakeGitHub] 404 ${method} ${pathname}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        message: "Not Found",
        documentation_url: "https://docs.github.com/rest",
      }),
    );
    return;
  }

  try {
    const body =
      method === "POST" || method === "PUT" || method === "PATCH"
        ? await readBody(req)
        : null;

    const result = matched.route.handler(
      matched.params,
      url.searchParams,
      body,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(result.headers || {}),
    };

    // Add link header for pagination (simplified)
    if (Array.isArray(result.body)) {
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const perPage = parseInt(url.searchParams.get("per_page") || "30", 10);
      // If we returned a full page, indicate there might be more
      if (result.body.length === perPage) {
        headers["link"] =
          `<${url.origin}${pathname}?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }
    }

    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.body));
  } catch (err) {
    console.error(`[FakeGitHub] Error handling ${method} ${pathname}:`, err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Internal Server Error" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[FakeGitHub] Fake GitHub API server running on http://0.0.0.0:${PORT}`,
  );
  console.log(
    `[FakeGitHub] Management API: POST http://localhost:${PORT}/___mgmt/{seed,add-repo,add-org,reset}`,
  );
  console.log(
    `[FakeGitHub] Health check:   GET  http://localhost:${PORT}/___mgmt/health`,
  );
  console.log(`[FakeGitHub] Default user: ${store.user.login}`);
  console.log(
    `[FakeGitHub] Default repos: ${Array.from(store.repos.keys()).join(", ")}`,
  );
  console.log(
    `[FakeGitHub] Default starred: ${Array.from(store.starredRepoKeys).join(", ") || "(none)"}`,
  );
  console.log(
    `[FakeGitHub] Default orgs: ${Array.from(store.orgs.keys()).join(", ") || "(none)"}`,
  );
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[FakeGitHub] Received SIGTERM, shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("[FakeGitHub] Received SIGINT, shutting down...");
  server.close(() => process.exit(0));
});

export { server, store, defaultStore };
