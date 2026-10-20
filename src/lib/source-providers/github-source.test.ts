import { describe, expect, mock, test } from "bun:test";
import { GitHubSourceProvider, type GithubRestRepository } from "./github-source";
import { encodeGitHubAppCredentials } from "@/lib/github-app-credentials";
import { generateKeyPairSync } from "node:crypto";

type ListForOrgParams = { org: string; type: "public" | "private" | "member"; per_page: number };
type OrgReposPage = (GithubRestRepository & { id: number })[];

function repo(id: number, name: string, owner = "acme"): GithubRestRepository & { id: number } {
  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
    clone_url: `https://github.com/${owner}/${name}.git`,
    owner: { login: owner, type: "Organization" },
    private: false,
    fork: false,
    has_issues: true,
    archived: false,
    size: 10,
    default_branch: "main",
    visibility: "public",
  };
}

/** Octokit errors carry the HTTP status; build the same shape here. */
function apiError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

const connection = {
  provider: "github" as const,
  url: "https://github.com",
  username: "me",
  token: "gh-secret",
  userId: "u1",
};

test("GitHub App lists installed repositories without using user or starred APIs", async () => {
  const provider = new GitHubSourceProvider({ ...connection, token: encodeGitHubAppCredentials({
    appId: "123", installationId: "456", privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  }) });
  const request = mock(async (route: string) => {
    expect(route).toBe("GET /installation/repositories");
    return { data: { total_count: 1, repositories: [repo(1, "private-tool")] } };
  });
  Object.defineProperty(provider, "octokit", { value: { request } });
  const repos = await provider.listRepositories({});
  expect(repos.map((item) => item.fullName)).toEqual(["acme/private-tool"]);
  expect(await provider.listStarredRepositories({})).toEqual([]);
});

test("GitHub App listing applies the same account filters as the token listing", async () => {
  const provider = new GitHubSourceProvider({ ...connection, token: encodeGitHubAppCredentials({
    appId: "123", installationId: "456", privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  }) });
  const personal = { ...repo(4, "dotfiles", "me"), owner: { login: "me", type: "User" } };
  const repositories = [
    repo(1, "tool"),
    { ...repo(2, "forked"), fork: true },
    repo(3, "other-tool", "other-org"),
    personal,
  ];
  const request = mock(async () => ({ data: { total_count: repositories.length, repositories } }));
  Object.defineProperty(provider, "octokit", { value: { request } });
  const config = {
    githubConfig: { skipForks: true, skipPersonalRepos: true, includeOrganizations: ["acme"] },
  } as any;

  expect((await provider.listRepositories(config)).map((item) => item.fullName)).toEqual(["acme/tool"]);
  // Cleanup lists past the allowlist, like the token path.
  expect(
    (await provider.listRepositories(config, { includeAllOrgsOverride: true })).map((item) => item.fullName)
  ).toEqual(["acme/tool", "other-org/other-tool"]);
  // Every installation org is discovered; the allowlist only narrows imports.
  const { organizations } = await provider.listOrganizations(config);
  expect(organizations.map((org) => org.name).sort()).toEqual(["acme", "other-org"]);
});

test("GitHub App Octokit authenticates requests with an installation token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const provider = new GitHubSourceProvider({ ...connection, token: encodeGitHubAppCredentials({ appId: "789", installationId: "987", privateKey }) });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_live", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("token ghs_live");
    return new Response(JSON.stringify({ total_count: 1, repositories: [repo(1, "private-tool")] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    expect(await provider.testConnection()).toEqual({ login: "me" });
    expect((await provider.listRepositories({})).map((item) => item.fullName)).toEqual(["acme/private-tool"]);
    expect(requests).toHaveLength(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function installOctokitDouble(
  provider: GitHubSourceProvider,
  paginate: (fn: unknown, params: ListForOrgParams) => Promise<OrgReposPage>
) {
  const double = { repos: { listForOrg: {} }, paginate };
  Object.defineProperty(provider, "octokit", { value: double });
}

describe("GitHubSourceProvider.listOrganizationRepositories", () => {
  test("without a token lists public repositories only", async () => {
    const paginate = mock(async (_fn: unknown, params: ListForOrgParams): Promise<OrgReposPage> => {
      expect(params.org).toBe("acme");
      expect(params.type).toBe("public");
      return [repo(1, "tool")];
    });
    const provider = new GitHubSourceProvider({ ...connection, token: "" });
    installOctokitDouble(provider, paginate);

    const repos = await provider.listOrganizationRepositories("acme");

    expect(paginate).toHaveBeenCalledTimes(1);
    expect(repos.map((r) => r.fullName)).toEqual(["acme/tool"]);
    expect(repos[0].organization).toBe("acme");
    expect(repos[0].sourceProvider).toBe("github");
    expect(repos[0].sourceUrl).toBe("https://github.com");
  });

  test("keeps public repositories when the org refuses the private and member passes with 403", async () => {
    const paginate = mock(async (_fn: unknown, params: ListForOrgParams): Promise<OrgReposPage> => {
      if (params.type === "public") return [repo(1, "tool")];
      throw apiError(403, "Resource not accessible by integration");
    });
    const provider = new GitHubSourceProvider(connection);
    installOctokitDouble(provider, paginate);

    const repos = await provider.listOrganizationRepositories("acme");

    expect(paginate).toHaveBeenCalledTimes(3);
    expect(repos.map((r) => r.fullName)).toEqual(["acme/tool"]);
  });

  test("degrades the same way when the private and member passes answer 401", async () => {
    const paginate = mock(async (_fn: unknown, params: ListForOrgParams): Promise<OrgReposPage> => {
      if (params.type === "public") return [repo(1, "tool")];
      throw apiError(401, "Bad credentials");
    });
    const provider = new GitHubSourceProvider(connection);
    installOctokitDouble(provider, paginate);

    const repos = await provider.listOrganizationRepositories("acme");

    expect(paginate).toHaveBeenCalledTimes(3);
    expect(repos.map((r) => r.fullName)).toEqual(["acme/tool"]);
  });

  test("dedupes repositories that are reachable through several listing types", async () => {
    const paginate = mock(async (_fn: unknown, params: ListForOrgParams): Promise<OrgReposPage> => {
      if (params.type === "public") return [repo(1, "tool")];
      if (params.type === "private") return [repo(1, "tool"), repo(2, "gadget")];
      return [repo(2, "gadget"), repo(3, "widget")];
    });
    const provider = new GitHubSourceProvider(connection);
    installOctokitDouble(provider, paginate);

    const repos = await provider.listOrganizationRepositories("acme");

    expect(paginate).toHaveBeenCalledTimes(3);
    expect(repos.map((r) => r.fullName)).toEqual(["acme/tool", "acme/gadget", "acme/widget"]);
  });

  test("rethrows failures of the public pass even without a token", async () => {
    const paginate = mock(async (_fn: unknown, _params: ListForOrgParams): Promise<OrgReposPage> => {
      throw apiError(500, "boom");
    });
    const provider = new GitHubSourceProvider({ ...connection, token: "" });
    installOctokitDouble(provider, paginate);

    await expect(provider.listOrganizationRepositories("acme")).rejects.toThrow("boom");
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  test("rethrows errors without an authz status from the private pass", async () => {
    const paginate = mock(async (_fn: unknown, params: ListForOrgParams): Promise<OrgReposPage> => {
      if (params.type === "public") return [repo(1, "tool")];
      throw new Error("network reset");
    });
    const provider = new GitHubSourceProvider(connection);
    installOctokitDouble(provider, paginate);

    await expect(provider.listOrganizationRepositories("acme")).rejects.toThrow("network reset");
    expect(paginate).toHaveBeenCalledTimes(2);
  });
});
