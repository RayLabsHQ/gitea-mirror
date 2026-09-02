/**
 * GitHub source adapter.
 *
 * Wraps the existing Octokit based discovery code in src/lib/github.ts so the
 * pipeline can treat GitHub like any other source. Without a token it falls
 * back to an unauthenticated client, which is enough to add public
 * repositories by URL.
 */
import { Octokit } from "@octokit/rest";
import type { Config } from "@/lib/db/schema";
import {
  createGitHubClient,
  getGithubOrganizations,
  getGithubRepositories,
  getGithubStarredRepositories,
} from "@/lib/github";
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
    this.octokit = connection.token.trim()
      ? createGitHubClient(
          connection.token,
          connection.userId,
          connection.username || undefined
        )
      : new Octokit({ baseUrl: githubApiBaseUrl() });
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
    const repos = await getGithubRepositories({
      octokit: this.octokit,
      config,
      includeCollaboratorReposOverride: options.includeCollaboratorReposOverride,
      includeAllOrgsOverride: options.includeAllOrgsOverride,
    });
    return this.stamp(repos);
  }

  async listStarredRepositories(config: Partial<Config>): Promise<GitRepo[]> {
    const repos = await getGithubStarredRepositories({ octokit: this.octokit, config });
    return this.stamp(repos);
  }

  listOrganizations(
    config: Partial<Config>,
    skipOrgNames?: Set<string>
  ): Promise<SourceOrganizationResult> {
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
    for (const type of ["public", "private", "member"] as const) {
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
    const { data } = await this.octokit.users.getAuthenticated();
    return { login: data.login, name: data.name, avatarUrl: data.avatar_url };
  }

  resolveRepositoryPath(segments: string[]): SourceRepositoryPath | null {
    return resolveFlatRepositoryPath(segments);
  }
}
