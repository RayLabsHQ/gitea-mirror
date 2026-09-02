/**
 * GitLab source adapter (gitlab.com and self hosted).
 *
 * Talks to the v4 REST API with a personal access token in the PRIVATE-TOKEN
 * header. Without a token only the configured user's public projects are
 * visible. Nested groups are flattened onto their top level group, because a
 * Gitea organization name cannot contain a slash.
 */
import type { Config } from "@/lib/db/schema";
import type { GitRepo, RepositoryVisibility } from "@/types/Repository";
import type { GitOrg } from "@/types/organizations";
import { filterSourceRepositories } from "./filters";
import {
  isSourceNotFound,
  sourceFetch,
  stripGitSuffix,
  toDate,
  withQuery,
} from "./http";
import type {
  ListRepositoriesOptions,
  SourceAccount,
  SourceConnection,
  SourceFailedOrganization,
  SourceOrganizationResult,
  SourceProvider,
  SourceRepositoryPath,
} from "./types";

const PAGE_SIZE = 100;
const MAX_PAGES = 500;

export interface GitLabNamespace {
  id?: number;
  kind?: string;
  path?: string;
  full_path?: string;
  name?: string;
}

export interface GitLabProject {
  id?: number;
  name?: string;
  path?: string;
  path_with_namespace?: string;
  web_url?: string;
  http_url_to_repo?: string;
  namespace?: GitLabNamespace;
  visibility?: string;
  archived?: boolean;
  forked_from_project?: { path_with_namespace?: string } | null;
  issues_enabled?: boolean;
  issues_access_level?: string;
  description?: string | null;
  default_branch?: string | null;
  created_at?: string;
  updated_at?: string;
  last_activity_at?: string;
  statistics?: { repository_size?: number };
}

export interface GitLabGroup {
  id?: number;
  name?: string;
  path?: string;
  full_path?: string;
  avatar_url?: string | null;
  created_at?: string;
}

interface GitLabUser {
  id?: number;
  username: string;
  name?: string | null;
  avatar_url?: string | null;
}

function normalizeVisibility(value: unknown): RepositoryVisibility {
  return value === "private" || value === "internal" ? value : "public";
}

/** The group a project sits under, flattened to the top level group. */
export function gitLabTopLevelNamespace(project: GitLabProject): string {
  const fullPath = project.namespace?.full_path || "";
  return fullPath.split("/")[0] || project.namespace?.path || "";
}

export function mapGitLabProject(
  project: GitLabProject,
  connection: Pick<SourceConnection, "url">,
  options: { isStarred?: boolean } = {}
): GitRepo {
  const namespacePath = project.namespace?.full_path || "";
  const fullName =
    project.path_with_namespace ||
    (namespacePath && project.path ? `${namespacePath}/${project.path}` : project.path || "");
  const name = project.path || fullName.split("/").at(-1) || project.name || "repository";
  const owner = gitLabTopLevelNamespace(project) || fullName.split("/")[0] || "unknown";
  const isGroup = project.namespace?.kind === "group";
  const visibility = normalizeVisibility(project.visibility);
  const repositorySizeBytes = project.statistics?.repository_size;

  return {
    name,
    fullName,
    url: project.web_url || `${connection.url}/${fullName}`,
    cloneUrl: project.http_url_to_repo || `${connection.url}/${fullName}.git`,

    owner,
    organization: isGroup ? owner : undefined,
    mirroredLocation: "",
    destinationOrg: null,

    // Internal projects are only visible to signed in users, so they are
    // private as far as a backup is concerned.
    isPrivate: visibility !== "public",
    isForked: Boolean(project.forked_from_project),
    forkedFrom: project.forked_from_project?.path_with_namespace ?? undefined,

    hasIssues:
      project.issues_enabled !== false && project.issues_access_level !== "disabled",
    isStarred: options.isStarred ?? false,
    isArchived: Boolean(project.archived),

    size: repositorySizeBytes ? Math.round(repositorySizeBytes / 1024) : 0,
    hasLFS: false,
    hasSubmodules: false,

    language: null,
    description: project.description ?? null,
    defaultBranch: project.default_branch || "main",
    visibility,

    status: "imported",
    isDisabled: false,

    importedAt: new Date(),
    createdAt: toDate(project.created_at),
    updatedAt: toDate(project.last_activity_at ?? project.updated_at),

    sourceProvider: "gitlab",
    sourceUrl: connection.url,
  };
}

export function mapGitLabGroup(group: GitLabGroup, repositoryCount: number): GitOrg {
  return {
    name: group.full_path || group.path || group.name || "",
    avatarUrl: group.avatar_url || "",
    membershipRole: "member",
    isIncluded: false,
    status: "imported",
    repositoryCount,
    createdAt: toDate(group.created_at),
    updatedAt: new Date(),
  };
}

/**
 * GitLab deep links put a "-" segment between the project path and the rest
 * (issues, tree, blob). Everything before it is the project; the last segment
 * is the project and the rest is the (possibly nested) group.
 */
export function resolveGitLabRepositoryPath(segments: string[]): SourceRepositoryPath | null {
  const marker = segments.indexOf("-");
  const path = (marker === -1 ? segments : segments.slice(0, marker))
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (path.length < 2) return null;

  const repo = stripGitSuffix(path[path.length - 1]);
  const owner = path.slice(0, -1).join("/");
  if (!repo || !owner) return null;

  return { owner, repo };
}

export class GitLabSourceProvider implements SourceProvider {
  readonly kind = "gitlab" as const;
  private readonly apiRoot: string;

  constructor(readonly connection: SourceConnection) {
    this.apiRoot = `${connection.url}/api/v4`;
  }

  private get hasToken(): boolean {
    return this.connection.token.trim().length > 0;
  }

  private headers(): Record<string, string> {
    return this.hasToken ? { "PRIVATE-TOKEN": this.connection.token } : {};
  }

  private encodedUser(): string {
    return encodeURIComponent(this.connection.username);
  }

  private async paginate<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = withQuery(`${this.apiRoot}${path}`, {
        ...params,
        per_page: PAGE_SIZE,
        page,
      });
      const { data, response } = await sourceFetch<T[]>(url, { headers: this.headers() });
      if (!Array.isArray(data) || data.length === 0) break;
      items.push(...data);
      if (!response.headers.get("x-next-page")) break;
    }
    return items;
  }

  /** Total item count for a list endpoint, from the x-total header. */
  private async total(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<number> {
    const url = withQuery(`${this.apiRoot}${path}`, { ...params, per_page: 1, page: 1 });
    const { data, response } = await sourceFetch<unknown[]>(url, { headers: this.headers() });
    const header = response.headers.get("x-total");
    const parsed = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(parsed)) return parsed;
    return Array.isArray(data) ? data.length : 0;
  }

  async listRepositories(
    config: Partial<Config>,
    options: ListRepositoriesOptions = {}
  ): Promise<GitRepo[]> {
    const projects = this.hasToken
      ? await this.paginate<GitLabProject>("/projects", {
          membership: true,
          order_by: "id",
          sort: "asc",
        })
      : await this.paginate<GitLabProject>(`/users/${this.encodedUser()}/projects`, {
          order_by: "id",
          sort: "asc",
        });

    const repos = projects.map((project) => mapGitLabProject(project, this.connection));
    return filterSourceRepositories(repos, {
      config,
      options,
      username: this.connection.username,
    });
  }

  async listStarredRepositories(_config: Partial<Config>): Promise<GitRepo[]> {
    const projects = this.hasToken
      ? await this.paginate<GitLabProject>("/projects", {
          starred: true,
          order_by: "id",
          sort: "asc",
        })
      : await this.paginate<GitLabProject>(
          `/users/${this.encodedUser()}/starred_projects`,
          { order_by: "id", sort: "asc" }
        );

    return projects.map((project) =>
      mapGitLabProject(project, this.connection, { isStarred: true })
    );
  }

  async listOrganizations(
    _config: Partial<Config>,
    skipOrgNames?: Set<string>
  ): Promise<SourceOrganizationResult> {
    if (!this.hasToken) {
      return { organizations: [], failedOrgs: [] };
    }

    const groups = await this.paginate<GitLabGroup>("/groups", {
      membership: true,
      top_level_only: true,
      order_by: "id",
      sort: "asc",
    });

    const organizations: GitOrg[] = [];
    const failedOrgs: SourceFailedOrganization[] = [];

    for (const group of groups) {
      const name = group.full_path || group.path || group.name || "";
      if (!name) continue;
      if (skipOrgNames?.has(name.toLowerCase())) {
        console.log(`Skipping group ${name} - ignored by user`);
        continue;
      }

      try {
        const count = await this.total(`/groups/${group.id}/projects`, {
          include_subgroups: true,
        });
        organizations.push(mapGitLabGroup(group, count));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to import group ${name} - ${reason}`);
        failedOrgs.push({ name, avatarUrl: group.avatar_url || "", reason });
      }
    }

    return { organizations, failedOrgs };
  }

  async getOrganization(name: string): Promise<GitOrg | null> {
    try {
      const { data } = await sourceFetch<GitLabGroup>(
        `${this.apiRoot}/groups/${encodeURIComponent(name)}`,
        { headers: this.headers() }
      );
      let count = 0;
      try {
        count = await this.total(`/groups/${data.id}/projects`, { include_subgroups: true });
      } catch {
        // The count is informational only.
      }
      return mapGitLabGroup(data, count);
    } catch (error) {
      if (isSourceNotFound(error)) return null;
      throw error;
    }
  }

  async listOrganizationRepositories(name: string): Promise<GitRepo[]> {
    const projects = await this.paginate<GitLabProject>(
      `/groups/${encodeURIComponent(name)}/projects`,
      { include_subgroups: true, order_by: "id", sort: "asc" }
    );
    return projects.map((project) => mapGitLabProject(project, this.connection));
  }

  async getRepository(owner: string, name: string): Promise<GitRepo | null> {
    try {
      const { data } = await sourceFetch<GitLabProject>(
        `${this.apiRoot}/projects/${encodeURIComponent(`${owner}/${name}`)}`,
        { headers: this.headers() }
      );
      return mapGitLabProject(data, this.connection);
    } catch (error) {
      if (isSourceNotFound(error)) return null;
      throw error;
    }
  }

  async isRepositoryStarred(owner: string, name: string): Promise<boolean> {
    const target = `${owner}/${name}`.toLowerCase();
    const projects = this.hasToken
      ? await this.paginate<GitLabProject>("/projects", {
          starred: true,
          search: name,
          simple: true,
        })
      : await this.paginate<GitLabProject>(
          `/users/${this.encodedUser()}/starred_projects`,
          { search: name, simple: true }
        );
    return projects.some(
      (project) => (project.path_with_namespace || "").toLowerCase() === target
    );
  }

  async testConnection(): Promise<SourceAccount> {
    if (!this.hasToken) {
      throw new Error("A GitLab personal access token is required.");
    }
    const { data } = await sourceFetch<GitLabUser>(`${this.apiRoot}/user`, {
      headers: this.headers(),
    });
    return {
      login: data.username,
      name: data.name ?? null,
      avatarUrl: data.avatar_url ?? null,
    };
  }

  resolveRepositoryPath(segments: string[]): SourceRepositoryPath | null {
    return resolveGitLabRepositoryPath(segments);
  }
}
