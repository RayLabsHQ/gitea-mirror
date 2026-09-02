/**
 * GitLab as a push target.
 *
 * Talks to the v4 REST API with a personal access token. Projects live in
 * a namespace: the token's own user, or a group looked up by path (and
 * created as a top level group when missing).
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

interface GitLabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace?: string;
  namespace?: { full_path?: string; path?: string };
  visibility?: string;
  archived?: boolean;
  http_url_to_repo?: string;
  web_url?: string;
  default_branch?: string;
  /** Set while a project waits in delayed deletion; the old path still redirects to it. */
  marked_for_deletion_at?: string | null;
  marked_for_deletion_on?: string | null;
}

interface GitLabNamespace {
  id: number;
  full_path?: string;
  path?: string;
  kind?: string;
}

const MAX_DESCRIPTION = 2000;

export class GitLabPushTarget implements PushTarget {
  readonly kind = "gitlab" as const;
  readonly baseUrl: string;
  private readonly apiRoot: string;

  constructor(private readonly connection: PushTargetConnection) {
    this.baseUrl = connection.url.replace(/\/+$/, "");
    this.apiRoot = `${this.baseUrl}/api/v4`;
  }

  private headers(): Record<string, string> {
    return { "PRIVATE-TOKEN": this.connection.token, "User-Agent": "gitea-mirror" };
  }

  pushCredentials(): GitCredentials {
    // GitLab documents "oauth2" as the user name for token pushes over HTTPS.
    return { username: "oauth2", token: this.connection.token };
  }

  async testConnection(): Promise<PushTargetIdentity> {
    const { data } = await targetFetch<{ username?: string }>(`${this.apiRoot}/user`, {
      headers: this.headers(),
    });
    if (!data?.username) {
      throw new PushTargetError("GitLab did not return a user for this token.");
    }
    let label = "GitLab";
    try {
      const version = await targetFetch<{ version?: string }>(`${this.apiRoot}/version`, {
        headers: this.headers(),
      });
      if (version.data?.version) label = `GitLab ${version.data.version}`;
    } catch {
      // The version is decoration only.
    }
    return { login: data.username, label };
  }

  private projectPath(owner: string, name: string): string {
    return encodeURIComponent(`${owner.replace(/^\/+|\/+$/g, "")}/${name}`);
  }

  private toRepository(project: GitLabProject, created: boolean): PushTargetRepository {
    const owner =
      project.namespace?.full_path ||
      project.path_with_namespace?.split("/").slice(0, -1).join("/") ||
      "";
    return {
      owner,
      name: project.path || project.name,
      pushUrl: project.http_url_to_repo || `${this.baseUrl}/${owner}/${project.path}.git`,
      htmlUrl: project.web_url || `${this.baseUrl}/${owner}/${project.path}`,
      isPrivate: project.visibility !== "public",
      archived: !!project.archived,
      created,
    };
  }

  async getRepository(owner: string, name: string): Promise<PushTargetRepository | null> {
    try {
      const { data } = await targetFetch<GitLabProject>(
        `${this.apiRoot}/projects/${this.projectPath(owner, name)}`,
        { headers: this.headers() }
      );
      // A deleted project on an instance with delayed deletion is renamed and
      // kept for a while, and its old path redirects to it. That is not a
      // repository we can push to; treat it as gone.
      if (data.marked_for_deletion_at || data.marked_for_deletion_on) return null;
      const requested = `${owner.replace(/^\/+|\/+$/g, "")}/${name}`.toLowerCase();
      if (data.path_with_namespace && data.path_with_namespace.toLowerCase() !== requested) return null;
      return this.toRepository(data, false);
    } catch (error) {
      if (isTargetNotFound(error)) return null;
      throw error;
    }
  }

  private ownsNamespace(owner: string): boolean {
    return owner.trim().toLowerCase() === this.connection.username.trim().toLowerCase();
  }

  /** Find the group for a path, creating a top level group when it is missing. */
  private async resolveGroupId(ownerPath: string): Promise<number> {
    try {
      const { data } = await targetFetch<GitLabNamespace>(
        `${this.apiRoot}/namespaces/${encodeURIComponent(ownerPath)}`,
        { headers: this.headers() }
      );
      if (data?.id) return data.id;
    } catch (error) {
      if (!isTargetNotFound(error)) throw error;
    }

    if (ownerPath.includes("/")) {
      throw new PushTargetError(
        `GitLab group "${ownerPath}" was not found. Nested groups are not created automatically; create it first.`,
        404
      );
    }

    try {
      const { data } = await targetFetch<GitLabNamespace>(`${this.apiRoot}/groups`, {
        method: "POST",
        headers: this.headers(),
        body: { name: ownerPath, path: ownerPath, visibility: "private" },
      });
      if (!data?.id) throw new PushTargetError(`GitLab did not return the group it created for "${ownerPath}".`);
      return data.id;
    } catch (error) {
      if (error instanceof PushTargetError) {
        throw new PushTargetError(
          `GitLab group "${ownerPath}" was not found and could not be created: ${error.message}`,
          error.status,
          error.url
        );
      }
      throw error;
    }
  }

  async ensureRepository(input: EnsureRepositoryInput): Promise<PushTargetRepository> {
    const existing = await this.getRepository(input.owner, input.name);
    if (existing) return existing;

    const body: Record<string, unknown> = {
      name: input.name,
      path: input.name,
      visibility: input.isPrivate ? "private" : "public",
      description: (input.description || "").slice(0, MAX_DESCRIPTION) || undefined,
      initialize_with_readme: false,
      issues_access_level: "disabled",
      wiki_access_level: "disabled",
    };
    if (!this.ownsNamespace(input.owner)) {
      body.namespace_id = await this.resolveGroupId(input.owner);
    }

    try {
      const { data } = await targetFetch<GitLabProject>(`${this.apiRoot}/projects`, {
        method: "POST",
        headers: this.headers(),
        body,
      });
      return this.toRepository(data, true);
    } catch (error) {
      if (error instanceof PushTargetError && error.status === 400) {
        // "has already been taken": lost a race with another run.
        const again = await this.getRepository(input.owner, input.name);
        if (again) return again;
      }
      throw error;
    }
  }

  async setDefaultBranch(owner: string, name: string, branch: string): Promise<void> {
    await targetFetch(`${this.apiRoot}/projects/${this.projectPath(owner, name)}`, {
      method: "PUT",
      headers: this.headers(),
      body: { default_branch: branch },
    });
  }

  async archiveRepository(owner: string, name: string): Promise<void> {
    await targetFetch(`${this.apiRoot}/projects/${this.projectPath(owner, name)}/archive`, {
      method: "POST",
      headers: this.headers(),
    });
  }

  async deleteRepository(owner: string, name: string): Promise<void> {
    try {
      await targetFetch(`${this.apiRoot}/projects/${this.projectPath(owner, name)}`, {
        method: "DELETE",
        headers: this.headers(),
      });
    } catch (error) {
      if (isTargetNotFound(error)) return;
      throw error;
    }
  }
}
