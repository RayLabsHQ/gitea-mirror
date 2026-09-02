/**
 * A push target is the host that receives `git push --mirror`.
 *
 * The engine only needs a handful of things from it: make sure the
 * repository exists, tell it where to push and with which credentials, and
 * archive or delete when the cleanup service asks. Everything else about
 * the host (issues, releases, wiki) is out of the engine's scope.
 */
import type { GitCredentials } from "../git";

export interface PushTargetRepository {
  owner: string;
  name: string;
  /** http(s) URL git pushes to. Credentials are supplied separately. */
  pushUrl: string;
  htmlUrl: string;
  isPrivate: boolean;
  archived: boolean;
  /** True when this call created the repository. */
  created: boolean;
}

export interface EnsureRepositoryInput {
  owner: string;
  name: string;
  isPrivate: boolean;
  description?: string | null;
}

export interface PushTargetIdentity {
  /** The login the token belongs to. */
  login: string;
  /** Human readable, e.g. "GitHub Enterprise 3.12" or "GitLab 17.4". */
  label?: string;
}

export class PushTargetError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string
  ) {
    super(message);
    this.name = "PushTargetError";
  }
}

export interface PushTarget {
  readonly kind: "github" | "gitlab" | "local";
  /** Base URL of the host, e.g. https://github.com. */
  readonly baseUrl: string;
  /** Credentials for the push. Null for targets that need none (local files). */
  pushCredentials(): GitCredentials | null;
  /** Check the token: returns who it belongs to or throws. */
  testConnection(): Promise<PushTargetIdentity>;
  getRepository(owner: string, name: string): Promise<PushTargetRepository | null>;
  /** Create the repository when missing. Never touches an existing one. */
  ensureRepository(input: EnsureRepositoryInput): Promise<PushTargetRepository>;
  archiveRepository(owner: string, name: string): Promise<void>;
  deleteRepository(owner: string, name: string): Promise<void>;
  /** Best effort: make the target open on the same branch as the source. */
  setDefaultBranch?(owner: string, name: string, branch: string): Promise<void>;
}

/** The connection details a target is built from. */
export interface PushTargetConnection {
  url: string;
  /** The account the token belongs to. */
  username: string;
  token: string;
}
