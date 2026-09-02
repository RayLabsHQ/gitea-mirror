/**
 * Gitea and Forgejo source adapter (Codeberg, self hosted instances).
 *
 * Talks to the v1 REST API with a token in the Authorization header. Gitea's
 * repository payload does not say whether the owner is a user or an
 * organization, so the adapter checks /orgs/{name} once per distinct owner
 * and remembers the answer for the rest of the run.
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

// Gitea caps page size at MAX_RESPONSE_ITEMS, 50 by default.
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;

export interface GiteaUser {
  id?: number;
  login?: string;
  username?: string;
  full_name?: string | null;
  avatar_url?: string | null;
}

export interface GiteaRepository {
  id?: number;
  name: string;
  full_name?: string;
  html_url?: string;
  clone_url?: string;
  owner?: GiteaUser;
  private?: boolean;
  internal?: boolean;
  fork?: boolean;
  parent?: { full_name?: string } | null;
  has_issues?: boolean;
  archived?: boolean;
  size?: number;
  language?: string | null;
  description?: string | null;
  default_branch?: string;
  created_at?: string;
  updated_at?: string;
}

export interface GiteaOrganization {
  id?: number;
  username?: string;
  name?: string;
  full_name?: string;
  avatar_url?: string | null;
}

export function mapGiteaRepository(
  repo: GiteaRepository,
  connection: Pick<SourceConnection, "url">,
  options: { isStarred?: boolean; isOrganization?: boolean } = {}
): GitRepo {
  const owner =
    repo.owner?.login || repo.owner?.username || repo.full_name?.split("/")[0] || "unknown";
  const fullName = repo.full_name || `${owner}/${repo.name}`;
  const visibility: RepositoryVisibility = repo.private
    ? "private"
    : repo.internal
      ? "internal"
      : "public";

  return {
    name: repo.name || fullName.split("/").at(-1) || "repository",
    fullName,
    url: repo.html_url || `${connection.url}/${fullName}`,
    cloneUrl: repo.clone_url || `${connection.url}/${fullName}.git`,

    owner,
    organization: options.isOrganization ? owner : undefined,
    mirroredLocation: "",
    destinationOrg: null,

    isPrivate: visibility !== "public",
    isForked: Boolean(repo.fork),
    forkedFrom: repo.parent?.full_name ?? undefined,

    hasIssues: repo.has_issues !== false,
    isStarred: options.isStarred ?? false,
    isArchived: Boolean(repo.archived),

    size: Number(repo.size) || 0,
    hasLFS: false,
    hasSubmodules: false,

    language: repo.language ?? null,
    description: repo.description ?? null,
    defaultBranch: repo.default_branch || "main",
    visibility,

    status: "imported",
    isDisabled: false,

    importedAt: new Date(),
    createdAt: toDate(repo.created_at),
    updatedAt: toDate(repo.updated_at),

    sourceProvider: "gitea",
    sourceUrl: connection.url,
  };
}

export function mapGiteaOrganization(org: GiteaOrganization, repositoryCount: number): GitOrg {
  return {
    name: org.username || org.name || "",
    avatarUrl: org.avatar_url || "",
    membershipRole: "member",
    isIncluded: false,
    status: "imported",
    repositoryCount,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Gitea namespaces are flat: the first two segments name the repository. */
export function resolveFlatRepositoryPath(segments: string[]): SourceRepositoryPath | null {
  const [owner, rawRepo] = segments.map((segment) => segment.trim());
  if (!owner || !rawRepo) return null;
  const repo = stripGitSuffix(rawRepo);
  if (!repo) return null;
  return { owner, repo };
}

export class GiteaSourceProvider implements SourceProvider {
  readonly kind = "gitea" as const;
  private readonly apiRoot: string;
  private readonly organizationCache = new Map<string, boolean>();

  constructor(readonly connection: SourceConnection) {
    this.apiRoot = `${connection.url}/api/v1`;
  }

  private get hasToken(): boolean {
    return this.connection.token.trim().length > 0;
  }

  private headers(): Record<string, string> {
    return this.hasToken ? { Authorization: `token ${this.connection.token}` } : {};
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
        limit: PAGE_SIZE,
        page,
      });
      const { data, response } = await sourceFetch<T[]>(url, { headers: this.headers() });
      if (!Array.isArray(data) || data.length === 0) break;
      items.push(...data);

      const header = response.headers.get("x-total-count");
      const total = header === null ? Number.NaN : Number(header);
      if (Number.isFinite(total)) {
        if (items.length >= total) break;
      } else if (data.length < PAGE_SIZE) {
        break;
      }
    }
    return items;
  }

  /** Total item count for a list endpoint, from the x-total-count header. */
  private async total(path: string): Promise<number> {
    const url = withQuery(`${this.apiRoot}${path}`, { limit: 1, page: 1 });
    const { data, response } = await sourceFetch<unknown[]>(url, { headers: this.headers() });
    const header = response.headers.get("x-total-count");
    const parsed = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(parsed)) return parsed;
    return Array.isArray(data) ? data.length : 0;
  }

  /** Whether a repository owner is an organization, cached per run. */
  private async isOrganization(login: string): Promise<boolean> {
    const key = login.trim().toLowerCase();
    if (!key) return false;
    if (key === this.connection.username.trim().toLowerCase()) return false;

    const cached = this.organizationCache.get(key);
    if (cached !== undefined) return cached;

    try {
      await sourceFetch<GiteaOrganization>(
        `${this.apiRoot}/orgs/${encodeURIComponent(login)}`,
        { headers: this.headers() }
      );
      this.organizationCache.set(key, true);
      return true;
    } catch (error) {
      if (isSourceNotFound(error)) {
        this.organizationCache.set(key, false);
      }
      return false;
    }
  }

  /** Load the account's organizations and seed the owner cache with them. */
  private async loadOrganizations(): Promise<GiteaOrganization[]> {
    const orgs = this.hasToken
      ? await this.paginate<GiteaOrganization>("/user/orgs")
      : await this.paginate<GiteaOrganization>(`/users/${this.encodedUser()}/orgs`);
    for (const org of orgs) {
      const name = org.username || org.name;
      if (name) this.organizationCache.set(name.toLowerCase(), true);
    }
    return orgs;
  }

  private async mapRepositories(
    repos: GiteaRepository[],
    options: { isStarred?: boolean } = {}
  ): Promise<GitRepo[]> {
    const mapped: GitRepo[] = [];
    for (const repo of repos) {
      const owner = repo.owner?.login || repo.owner?.username || "";
      const isOrganization = await this.isOrganization(owner);
      mapped.push(mapGiteaRepository(repo, this.connection, { ...options, isOrganization }));
    }
    return mapped;
  }

  async listRepositories(
    config: Partial<Config>,
    options: ListRepositoriesOptions = {}
  ): Promise<GitRepo[]> {
    await this.loadOrganizations();
    const repos = this.hasToken
      ? await this.paginate<GiteaRepository>("/user/repos")
      : await this.paginate<GiteaRepository>(`/users/${this.encodedUser()}/repos`);

    const mapped = await this.mapRepositories(repos);
    return filterSourceRepositories(mapped, {
      config,
      options,
      username: this.connection.username,
    });
  }

  async listStarredRepositories(_config: Partial<Config>): Promise<GitRepo[]> {
    const repos = this.hasToken
      ? await this.paginate<GiteaRepository>("/user/starred")
      : await this.paginate<GiteaRepository>(`/users/${this.encodedUser()}/starred`);
    return this.mapRepositories(repos, { isStarred: true });
  }

  async listOrganizations(
    _config: Partial<Config>,
    skipOrgNames?: Set<string>
  ): Promise<SourceOrganizationResult> {
    const orgs = await this.loadOrganizations();
    const organizations: GitOrg[] = [];
    const failedOrgs: SourceFailedOrganization[] = [];

    for (const org of orgs) {
      const name = org.username || org.name || "";
      if (!name) continue;
      if (skipOrgNames?.has(name.toLowerCase())) {
        console.log(`Skipping organization ${name} - ignored by user`);
        continue;
      }

      try {
        const count = await this.total(`/orgs/${encodeURIComponent(name)}/repos`);
        organizations.push(mapGiteaOrganization(org, count));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to import organization ${name} - ${reason}`);
        failedOrgs.push({ name, avatarUrl: org.avatar_url || "", reason });
      }
    }

    return { organizations, failedOrgs };
  }

  async getOrganization(name: string): Promise<GitOrg | null> {
    try {
      const { data } = await sourceFetch<GiteaOrganization>(
        `${this.apiRoot}/orgs/${encodeURIComponent(name)}`,
        { headers: this.headers() }
      );
      this.organizationCache.set(name.toLowerCase(), true);
      let count = 0;
      try {
        count = await this.total(`/orgs/${encodeURIComponent(name)}/repos`);
      } catch {
        // The count is informational only.
      }
      return mapGiteaOrganization(data, count);
    } catch (error) {
      if (isSourceNotFound(error)) return null;
      throw error;
    }
  }

  async listOrganizationRepositories(name: string): Promise<GitRepo[]> {
    const repos = await this.paginate<GiteaRepository>(
      `/orgs/${encodeURIComponent(name)}/repos`
    );
    return repos.map((repo) =>
      mapGiteaRepository(repo, this.connection, { isOrganization: true })
    );
  }

  async getRepository(owner: string, name: string): Promise<GitRepo | null> {
    try {
      const { data } = await sourceFetch<GiteaRepository>(
        `${this.apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        { headers: this.headers() }
      );
      const isOrganization = await this.isOrganization(
        data.owner?.login || data.owner?.username || owner
      );
      return mapGiteaRepository(data, this.connection, { isOrganization });
    } catch (error) {
      if (isSourceNotFound(error)) return null;
      throw error;
    }
  }

  async isRepositoryStarred(owner: string, name: string): Promise<boolean> {
    if (!this.hasToken) {
      throw new Error("A token is required to check starred repositories.");
    }
    try {
      await sourceFetch<undefined>(
        `${this.apiRoot}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        { headers: this.headers() }
      );
      return true;
    } catch (error) {
      if (isSourceNotFound(error)) return false;
      throw error;
    }
  }

  async testConnection(): Promise<SourceAccount> {
    if (!this.hasToken) {
      throw new Error("An access token is required.");
    }
    const { data } = await sourceFetch<GiteaUser>(`${this.apiRoot}/user`, {
      headers: this.headers(),
    });
    return {
      login: data.login || data.username || "",
      name: data.full_name ?? null,
      avatarUrl: data.avatar_url ?? null,
    };
  }

  resolveRepositoryPath(segments: string[]): SourceRepositoryPath | null {
    return resolveFlatRepositoryPath(segments);
  }
}
