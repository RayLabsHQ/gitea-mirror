/**
 * One entry point per operation, whatever the destination.
 *
 * Gitea and Forgejo are pull mirrors: the existing functions in gitea.ts
 * ask the destination to fetch. GitHub and GitLab are push targets served
 * by the push engine. Every route, the scheduler and recovery go through
 * here so the choice is made in one place, and tests can inject the
 * implementations to assert which path a destination takes.
 */
import type { Octokit } from "@octokit/rest";
import type { Config, Repository } from "@/lib/db/schema";
import { usesPushEngine } from "@/lib/destination-connection";

export interface MirrorRepositoryArgs {
  config: Partial<Config>;
  octokit: Octokit | null;
  repository: Repository;
  /** Set when the caller already resolved the destination organization. */
  orgName?: string;
  /** Set when the caller already created the Gitea organization. */
  giteaOrgId?: number;
}

export interface SyncRepositoryArgs {
  config: Partial<Config>;
  repository: Repository;
}

export interface MirrorDispatchDeps {
  push: (args: { config: Partial<Config>; repository: Repository; mode: "mirror" | "sync" }) => Promise<unknown>;
  giteaMirror: (args: { config: Partial<Config>; octokit: Octokit | null; repository: Repository }) => Promise<unknown>;
  giteaOrgMirror: (args: {
    config: Partial<Config>;
    octokit: Octokit | null;
    repository: Repository;
    orgName: string;
    giteaOrgId?: number;
  }) => Promise<unknown>;
  giteaSync: (args: SyncRepositoryArgs) => Promise<unknown>;
}

export type MirrorTransport = "pull" | "push";

/** Which transport a config's destination uses. */
export function resolveMirrorTransport(config: Partial<Config> | null | undefined): MirrorTransport {
  return usesPushEngine(config) ? "push" : "pull";
}

export function createMirrorDispatcher(deps: MirrorDispatchDeps) {
  return {
    async mirror({ config, octokit, repository, orgName, giteaOrgId }: MirrorRepositoryArgs): Promise<unknown> {
      if (resolveMirrorTransport(config) === "push") {
        return deps.push({ config, repository, mode: "mirror" });
      }
      if (orgName) {
        return deps.giteaOrgMirror({ config, octokit, repository, orgName, giteaOrgId });
      }
      return deps.giteaMirror({ config, octokit, repository });
    },
    async sync({ config, repository }: SyncRepositoryArgs): Promise<unknown> {
      if (resolveMirrorTransport(config) === "push") {
        return deps.push({ config, repository, mode: "sync" });
      }
      return deps.giteaSync({ config, repository });
    },
  };
}

/** The production dispatcher. Imports are lazy so this module stays cheap to load and cycle free. */
const defaultDispatcher = createMirrorDispatcher({
  push: async (args) => {
    const { pushMirrorRepository } = await import("@/lib/push-engine/mirror");
    return pushMirrorRepository(args);
  },
  giteaMirror: async ({ config, octokit, repository }) => {
    const { mirrorGithubRepoToGitea } = await import("@/lib/gitea");
    return mirrorGithubRepoToGitea({ config, octokit, repository });
  },
  giteaOrgMirror: async ({ config, octokit, repository, orgName, giteaOrgId }) => {
    const gitea = await import("@/lib/gitea");
    if (giteaOrgId !== undefined) {
      return gitea.mirrorGitHubRepoToGiteaOrg({ config, octokit, repository, orgName, giteaOrgId });
    }
    return gitea.mirrorGitHubOrgRepoToGiteaOrg({ config, octokit, repository, orgName });
  },
  giteaSync: async ({ config, repository }) => {
    const { syncGiteaRepo } = await import("@/lib/gitea");
    return syncGiteaRepo({ config, repository });
  },
});

/** Create or update the mirror of one repository on the configured destination. */
export function mirrorRepositoryToDestination(args: MirrorRepositoryArgs): Promise<unknown> {
  return defaultDispatcher.mirror(args);
}

/** Bring an existing mirror up to date on the configured destination. */
export function syncRepositoryOnDestination(args: SyncRepositoryArgs): Promise<unknown> {
  return defaultDispatcher.sync(args);
}
