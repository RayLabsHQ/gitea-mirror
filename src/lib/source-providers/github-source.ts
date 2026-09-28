/**
 * GitHub source adapter.
 *
 * Wraps the existing Octokit based discovery code in src/lib/github.ts so the
 * pipeline can treat GitHub like any other source. Without a token it falls
 * back to an unauthenticated client, which is enough to add public
 * repositories by URL.
 */
import type { Octokit } from "@octokit/rest";
import type { Config } from "@/lib/db/schema";
import { parseGitHubAppCredentials, resolveGitHubAccessToken } from "@/lib/github-app-credentials";
import {
  createGitHubClient,
  createPublicGitHubClient,
  getGithubOrganizations,
  getGithubRepositories,
  getGithubStarredRepositories,
} from "@/lib/github";
import { resolveGitHubApiBaseUrl } from "@/lib/sources";
import type { GitRepo, RepositoryVisibility } from "@/types/Repository";
import type { GitOrg } from "@/types/organizations";
import { toDate } from "./http";
import { resolveFlatRepositoryPath } from "./gitea-source";
import type {
  ListRepositoriesOptions,
  SourceAccount,
  SourceConnection,
  SourceOrganizationResult,
  SourceProvider,
  SourceRepositoryPath,
} from "./types";

/** The REST API base, honoring GH_API_URL / GITHUB_API_URL for GHES and GHEC. */
export function githubApiBaseUrl(): string {
  return process.env.GH_API_URL || process.env.GITHUB_API_URL || "https://api.github.com";
}

export interface GithubRestRepository {
  name: string;
  full_name: string;
  html_url: string;
  clone_url?: string | null;
  owner: { login: string; type?: string };
  private?: boolean;
  fork?: boolean;
  parent?: { full_name?: string } | null;
  has_issues?: boolean;
  archived?: boolean;
  size?: number;
  language?: string | null;
  description?: string | null;
  default_branch?: string;
  visibility?: string;
  disabled?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export function mapGithubRestRepository(
  repo: GithubRestRepository,
  connection: Pick<SourceConnection, "url">,
  options: { isStarred?: boolean } = {}
): GitRepo {
  const isOrganization = repo.owner.type === "Organization";
  return {
    name: repo.name,
    fullName: repo.full_name,
    url: repo.html_url,
    cloneUrl: repo.clone_url ?? "",

    owner: repo.owner.login,
    organization: isOrganization ? repo.owner.login : undefined,
    mirroredLocation: "",
    destinationOrg: null,

    isPrivate: Boolean(repo.private),
    isForked: Boolean(repo.fork),
    forkedFrom: repo.parent?.full_name ?? undefined,

    hasIssues: repo.has_issues ?? false,
    isStarred: options.isStarred ?? false,
    isArchived: repo.archived ?? false,

    size: repo.size ?? 0,
    hasLFS: false,
    hasSubmodules: false,

    language: repo.language ?? null,
    description: repo.description ?? null,
    defaultBranch: repo.default_branch ?? "main",
    visibility: (repo.visibility ?? "public") as RepositoryVisibility,

    status: "imported",
    isDisabled: repo.disabled ?? false,

    importedAt: new Date(),
    createdAt: toDate(repo.created_at),
    updatedAt: toDate(repo.updated_at),

    sourceProvider: "github",
    sourceUrl: connection.url,
  };
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

export class GitHubSourceProvider implements SourceProvider {
  readonly kind = "github" as const;
  readonly octokit: Octokit;

  constructor(readonly connection: SourceConnection) {
    // A GitHub Enterprise source URL drives the API base; github.com (the
    // default) keeps the GH_API_URL env default.
    const apiBaseUrl = resolveGitHubApiBaseUrl(connection.url);
    const app = parseGitHubAppCredentials(connection.token);
    // Tokenless: the throttled public client, never an empty token — anonymous
    // GitHub runs at 60 req/hr, so the onRateLimit backoff must stay attached.
    this.octokit = app
      ? createPublicGitHubClient(apiBaseUrl, connection.userId)
      : connection.token.trim()
      ? createGitHubClient(
          connection.token,
          connection.userId,
          connection.username || undefined,
          apiBaseUrl
        )
      : createPublicGitHubClient(apiBaseUrl);
    if (app) {
      this.octokit.hook.before("request", async (options) => {
        options.headers = {
          ...options.headers,
          authorization: `token ${await resolveGitHubAccessToken(connection.token, apiBaseUrl || githubApiBaseUrl())}`,
        };
      });
    }
  }

  private stamp(repos: GitRepo[]): GitRepo[] {
    return repos.map((repo) => ({
      ...repo,
      sourceProvider: "github" as const,
      sourceUrl: this.connection.url,
    }));
  }

  async listRepositories(
    config: Partial<Config>,
    options: ListRepositoriesOptions = {}
  ): Promise<GitRepo[]> {
    if (parseGitHubAppCredentials(this.connection.token)) {
      const repos: GithubRestRepository[] = [];
      let page = 1;
      while (true) {
        const { data } = await this.octokit.request("GET /installation/repositories", { per_page: 100, page });
        repos.push(...data.repositories as GithubRestRepository[]);
        if (repos.length >= data.total_count || data.repositories.length === 0) break;
        page++;
      }
      return this.stamp(repos.map((repo) => mapGithubRestRepository(repo as GithubRestRepository, this.connection)));
    }
    const repos = await getGithubRepositories({
      octokit: this.octokit,
      config,
      includeCollaboratorReposOverride: options.includeCollaboratorReposOverride,
      includeAllOrgsOverride: options.includeAllOrgsOverride,
      orgForkOverrides: options.orgForkOverrides,
    });
    return this.stamp(repos);
  }

  async listStarredRepositories(config: Partial<Config>): Promise<GitRepo[]> {
    if (parseGitHubAppCredentials(this.connection.token)) return [];
    const repos = await getGithubStarredRepositories({ octokit: this.octokit, config });
    return this.stamp(repos);
  }

  listOrganizations(
    config: Partial<Config>,
    skipOrgNames?: Set<string>
  ): Promise<SourceOrganizationResult> {
    if (parseGitHubAppCredentials(this.connection.token)) {
      return this.listRepositories(config).then((repos) => ({
        organizations: [...new Set(repos.map((repo) => repo.organization).filter((name): name is string => !!name))]
          .filter((name) => !skipOrgNames?.has(name))
          .map((name) => ({ name, avatarUrl: "", membershipRole: "member" as const, isIncluded: false, status: "imported" as const, repositoryCount: repos.filter((repo) => repo.organization === name).length, createdAt: new Date(), updatedAt: new Date() })),
        failedOrgs: [],
      }));
    }
    return getGithubOrganizations({ octokit: this.octokit, config, skipOrgNames });
  }

  async getOrganization(name: string): Promise<GitOrg | null> {
    try {
      const { data } = await this.octokit.orgs.get({ org: name });
      return {
        name: data.login,
        avatarUrl: data.avatar_url,
        membershipRole: "member",
        isIncluded: false,
        status: "imported",
        repositoryCount: data.public_repos + (data.total_private_repos ?? 0),
        createdAt: toDate(data.created_at),
        updatedAt: toDate(data.updated_at),
      };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  async listOrganizationRepositories(name: string): Promise<GitRepo[]> {
    // Public, private and member listings overlap; dedupe by id so a repo
    // the token can reach through several paths is only imported once.
    const seen = new Set<number>();
    const collected: GithubRestRepository[] = [];
    // An unauthenticated client can only reach the public listing, so the
    // private/member passes would 401 by design; skip them entirely. With a
    // token, an org that refuses those listings must not cost us the public
    // repos either.
    const types = this.connection.token.trim()
      ? (["public", "private", "member"] as const)
      : (["public"] as const);
    for (const type of types) {
      try {
        const page = await this.octokit.paginate(this.octokit.repos.listForOrg, {
          org: name,
          type,
          per_page: 100,
        });
        for (const repo of page) {
          if (seen.has(repo.id)) continue;
          seen.add(repo.id);
          collected.push(repo as GithubRestRepository);
        }
      } catch (error) {
        // A token that cannot see this org's private/member listings (401
        // expired/insufficient token, 403 SAML-protected or blocked) must
        // not lose the public repos. Any other failure, including on the
        // public pass, is a real error.
        const status = statusOf(error);
        if (type !== "public" && (status === 401 || status === 403)) continue;
        throw error;
      }
    }
    return collected
      .filter((repo) => !repo.disabled)
      .map((repo) => mapGithubRestRepository(repo, this.connection));
  }

  async getRepository(owner: string, name: string): Promise<GitRepo | null> {
    try {
      const { data } = await this.octokit.rest.repos.get({ owner, repo: name });
      return mapGithubRestRepository(data as GithubRestRepository, this.connection);
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  async isRepositoryStarred(owner: string, name: string): Promise<boolean> {
    if (parseGitHubAppCredentials(this.connection.token)) return false;
    try {
      await this.octokit.rest.activity.checkRepoIsStarredByAuthenticatedUser({
        owner,
        repo: name,
      });
      return true;
    } catch (error) {
      if (statusOf(error) === 404) return false;
      throw error;
    }
  }

  async testConnection(): Promise<SourceAccount> {
    if (parseGitHubAppCredentials(this.connection.token)) {
      await this.octokit.request("GET /installation/repositories", { per_page: 1 });
      return { login: this.connection.username };
    }
    const { data } = await this.octokit.users.getAuthenticated();
    return { login: data.login, name: data.name, avatarUrl: data.avatar_url };
  }

  resolveRepositoryPath(segments: string[]): SourceRepositoryPath | null {
    return resolveFlatRepositoryPath(segments);
  }
}
