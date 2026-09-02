/**
 * GitHub as a push target.
 *
 * Talks to the REST API with the account's token. github.com uses
 * api.github.com; any other host is treated as GitHub Enterprise and gets
 * the `/api/v3` prefix on the instance URL.
 */
import type { GitCredentials } from "../git";
import { isTargetNotFound, targetFetch } from "./http";
import {
  PushTargetError,
  type EnsureRepositoryInput,
  type PushTarget,
  type PushTargetConnection,
  type PushTargetIdentity,
  type PushTargetRepository,
} from "./types";

interface GitHubRepo {
  name: string;
  full_name?: string;
  owner?: { login?: string };
  private?: boolean;
  archived?: boolean;
  clone_url?: string;
  html_url?: string;
  default_branch?: string;
}

const MAX_DESCRIPTION = 350;

export function githubApiRootFor(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    host = "";
  }
  if (!host || host === "github.com" || host === "www.github.com") {
    return "https://api.github.com";
  }
  return `${baseUrl.replace(/\/+$/, "")}/api/v3`;
}

export class GitHubPushTarget implements PushTarget {
  readonly kind = "github" as const;
  readonly baseUrl: string;
  private readonly apiRoot: string;

  constructor(private readonly connection: PushTargetConnection) {
    this.baseUrl = connection.url.replace(/\/+$/, "");
    this.apiRoot = githubApiRootFor(this.baseUrl);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.connection.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gitea-mirror",
    };
  }

  pushCredentials(): GitCredentials {
    // GitHub accepts any user name with a token as the password; the account
    // name keeps audit logs readable.
    return { username: this.connection.username.trim() || "x-access-token", token: this.connection.token };
  }

  async testConnection(): Promise<PushTargetIdentity> {
    const { data } = await targetFetch<{ login?: string }>(`${this.apiRoot}/user`, {
      headers: this.headers(),
    });
    if (!data?.login) {
      throw new PushTargetError("GitHub did not return a user for this token.");
    }
    const label = this.apiRoot === "https://api.github.com" ? "GitHub" : "GitHub Enterprise";
    return { login: data.login, label };
  }

  private toRepository(repo: GitHubRepo, created: boolean): PushTargetRepository {
    const owner = repo.owner?.login || repo.full_name?.split("/")[0] || "";
    return {
      owner,
      name: repo.name,
      pushUrl: repo.clone_url || `${this.baseUrl}/${owner}/${repo.name}.git`,
      htmlUrl: repo.html_url || `${this.baseUrl}/${owner}/${repo.name}`,
      isPrivate: !!repo.private,
      archived: !!repo.archived,
      created,
    };
  }

  async getRepository(owner: string, name: string): Promise<PushTargetRepository | null> {
    try {
      const { data } = await targetFetch<GitHubRepo>(
        `${this.apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        { headers: this.headers() }
      );
      return this.toRepository(data, false);
    } catch (error) {
      if (isTargetNotFound(error)) return null;
      throw error;
    }
  }

  private ownsNamespace(owner: string): boolean {
    return owner.trim().toLowerCase() === this.connection.username.trim().toLowerCase();
  }

  async ensureRepository(input: EnsureRepositoryInput): Promise<PushTargetRepository> {
    const existing = await this.getRepository(input.owner, input.name);
    if (existing) return existing;

    const body = {
      name: input.name,
      private: input.isPrivate,
      description: (input.description || "").slice(0, MAX_DESCRIPTION) || undefined,
      auto_init: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    };
    const url = this.ownsNamespace(input.owner)
      ? `${this.apiRoot}/user/repos`
      : `${this.apiRoot}/orgs/${encodeURIComponent(input.owner)}/repos`;

    try {
      const { data } = await targetFetch<GitHubRepo>(url, {
        method: "POST",
        headers: this.headers(),
        body,
      });
      return this.toRepository(data, true);
    } catch (error) {
      if (error instanceof PushTargetError) {
        if (error.status === 404 && !this.ownsNamespace(input.owner)) {
          throw new PushTargetError(
            `GitHub organization "${input.owner}" was not found, or the token cannot create repositories in it. ` +
              "GitHub organizations cannot be created through the API: create it first and make the token's user a member with repository creation rights.",
            error.status,
            error.url
          );
        }
        if (error.status === 422) {
          // Lost a race with another run, or the name exists in another casing.
          const again = await this.getRepository(input.owner, input.name);
          if (again) return again;
        }
      }
      throw error;
    }
  }

  async setDefaultBranch(owner: string, name: string, branch: string): Promise<void> {
    await targetFetch(`${this.apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: this.headers(),
      body: { default_branch: branch },
    });
  }

  async archiveRepository(owner: string, name: string): Promise<void> {
    await targetFetch(`${this.apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: this.headers(),
      body: { archived: true },
    });
  }

  async deleteRepository(owner: string, name: string): Promise<void> {
    try {
      await targetFetch(`${this.apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: this.headers(),
      });
    } catch (error) {
      if (error instanceof PushTargetError && error.status === 403) {
        throw new PushTargetError(
          `GitHub refused to delete ${owner}/${name}: the token needs the delete_repo scope.`,
          error.status,
          error.url
        );
      }
      if (isTargetNotFound(error)) return;
      throw error;
    }
  }
}
