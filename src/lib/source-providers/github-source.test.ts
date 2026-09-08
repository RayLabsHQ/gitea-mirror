import { describe, expect, mock, test } from "bun:test";
import { GitHubSourceProvider, type GithubRestRepository } from "./github-source";

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
