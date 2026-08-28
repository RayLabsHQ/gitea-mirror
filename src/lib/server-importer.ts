import type { Server } from "@/lib/db/schema";
import type { GitOrg } from "@/types/organizations";
import type { GitRepo, RepositoryVisibility } from "@/types/Repository";

type ImportableServer = Pick<Server, "type" | "url" | "username">;

export interface ServerImportResult {
  repositories: GitRepo[];
  organizations: GitOrg[];
  failedOrgs: { name: string; avatarUrl: string; reason: string }[];
}

function baseUrl(url: string) {
  return url.replace(/\/$/, "");
}

function visibility(value: unknown): RepositoryVisibility {
  return value === "private" || value === "internal" ? value : "public";
}

function date(value: unknown): Date {
  const parsed = typeof value === "string" || typeof value === "number" ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<{ data: T; response: Response }> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Server responded with status ${response.status}`);
  }
  return { data: await response.json() as T, response };
}

async function fetchGitLabPages<T>(url: string, token: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = url.includes("?") ? "&" : "?";
    const { data, response } = await fetchJson<T[]>(`${url}${separator}per_page=100&page=${page}`, {
      "PRIVATE-TOKEN": token,
      Accept: "application/json",
    });
    items.push(...data);
    if (!response.headers.get("x-next-page") || data.length === 0) break;
  }
  return items;
}

async function fetchGiteaPages<T>(url: string, token: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = url.includes("?") ? "&" : "?";
    const { data } = await fetchJson<T[]>(`${url}${separator}limit=100&page=${page}`, {
      Authorization: `token ${token}`,
      Accept: "application/json",
    });
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

function mapGitLabRepo(repo: any): GitRepo {
  const fullName = repo.path_with_namespace || `${repo.namespace?.full_path || "unknown"}/${repo.path || repo.name}`;
  const namespace = repo.namespace?.full_path || "";
  const organization = repo.namespace?.kind === "group" ? namespace : undefined;
  return {
    name: repo.name || repo.path || fullName.split("/").at(-1) || "repository",
    fullName,
    url: repo.web_url || "",
    cloneUrl: repo.http_url_to_repo || repo.web_url || "",
    owner: namespace || fullName.split("/").slice(0, -1).join("/"),
    organization,
    isPrivate: repo.visibility === "private",
    isForked: Boolean(repo.forked_from_project),
    forkedFrom: repo.forked_from_project?.path_with_namespace,
    hasIssues: repo.issues_enabled !== false,
    isStarred: false,
    isArchived: Boolean(repo.archived),
    size: 0,
    hasLFS: false,
    hasSubmodules: false,
    language: null,
    description: repo.description ?? null,
    defaultBranch: repo.default_branch || "main",
    visibility: visibility(repo.visibility),
    status: "imported",
    importedAt: new Date(),
    createdAt: date(repo.created_at),
    updatedAt: date(repo.last_activity_at || repo.updated_at),
  };
}

function mapGiteaRepo(repo: any): GitRepo {
  const owner = repo.owner?.login || repo.owner?.username || "unknown";
  const fullName = repo.full_name || `${owner}/${repo.name}`;
  return {
    name: repo.name || fullName.split("/").at(-1) || "repository",
    fullName,
    url: repo.html_url || "",
    cloneUrl: repo.clone_url || repo.html_url || "",
    owner,
    organization: repo.owner?.type === "Organization" ? owner : undefined,
    isPrivate: Boolean(repo.private),
    isForked: Boolean(repo.fork),
    forkedFrom: repo.parent?.full_name,
    hasIssues: repo.has_issues !== false,
    isStarred: Boolean(repo.starred),
    isArchived: Boolean(repo.archived),
    size: Number(repo.size) || 0,
    hasLFS: Boolean(repo.lfs),
    hasSubmodules: false,
    language: repo.language ?? null,
    description: repo.description ?? null,
    defaultBranch: repo.default_branch || "main",
    visibility: visibility(repo.private ? "private" : repo.internal ? "internal" : "public"),
    status: "imported",
    importedAt: new Date(),
    createdAt: date(repo.created_at),
    updatedAt: date(repo.updated_at),
  };
}

export async function importServerData(server: ImportableServer, token: string): Promise<ServerImportResult> {
  const root = baseUrl(server.url);
  if (server.type === "gitlab") {
    const [projects, groups] = await Promise.all([
      fetchGitLabPages<any>(`${root}/api/v4/projects?membership=true&simple=true&order_by=id&sort=asc`, token),
      fetchGitLabPages<any>(`${root}/api/v4/groups?membership=true&order_by=id&sort=asc`, token),
    ]);
    const repositories = projects.map(mapGitLabRepo);
    const organizations = groups.map((group) => ({
      name: group.full_path || group.path || group.name,
      avatarUrl: group.avatar_url || "",
      membershipRole: "member" as const,
      isIncluded: false,
      status: "imported" as const,
      repositoryCount: 0,
      createdAt: date(group.created_at),
      updatedAt: date(group.updated_at),
    }));
    return { repositories, organizations, failedOrgs: [] };
  }

  if (server.type === "gitea" || server.type === "forgejo") {
    const [userRepos, orgs] = await Promise.all([
      fetchGiteaPages<any>(`${root}/api/v1/user/repos`, token),
      fetchGiteaPages<any>(`${root}/api/v1/user/orgs`, token),
    ]);
    const failedOrgs: ServerImportResult["failedOrgs"] = [];
    const orgRepos = await Promise.all(orgs.map(async (org) => {
      const name = org.username || org.name;
      try {
        return await fetchGiteaPages<any>(`${root}/api/v1/orgs/${encodeURIComponent(name)}/repos`, token);
      } catch (error) {
        failedOrgs.push({ name, avatarUrl: org.avatar_url || "", reason: error instanceof Error ? error.message : String(error) });
        return [];
      }
    }));
    const byFullName = new Map<string, GitRepo>();
    for (const repo of [...userRepos, ...orgRepos.flat()].map(mapGiteaRepo)) byFullName.set(repo.fullName.toLowerCase(), repo);
    const organizations = orgs.map((org) => ({
      name: org.username || org.name,
      avatarUrl: org.avatar_url || "",
      membershipRole: "member" as const,
      isIncluded: false,
      status: "imported" as const,
      repositoryCount: Array.from(byFullName.values()).filter((repo) => repo.organization === (org.username || org.name)).length,
      createdAt: date(org.created_at),
      updatedAt: date(org.updated_at),
    }));
    return { repositories: Array.from(byFullName.values()), organizations, failedOrgs };
  }

  throw new Error(`Import is not supported for ${server.type}`);
}
