import type { Config } from "@/lib/db/schema";
import type { GitRepo } from "@/types/Repository";
import type { GitOrg } from "@/types/organizations";
import type { SourceProviderKind } from "./kinds";

/** Everything an adapter needs to talk to one source host. */
export interface SourceConnection {
  provider: SourceProviderKind;
  /** Normalized base URL of the instance, without a trailing slash. */
  url: string;
  /** The account the token belongs to. */
  username: string;
  /** Decrypted token. Empty means unauthenticated, public-only access. */
  token: string;
  /** Owning user, used for rate limit tracking on GitHub. */
  userId?: string;
}

export interface ListRepositoriesOptions {
  /** Include collaborator repositories regardless of the config filter. */
  includeCollaboratorReposOverride?: boolean;
  /** Ignore the organization allowlist and return every org repository. */
  includeAllOrgsOverride?: boolean;
}

export interface SourceFailedOrganization {
  name: string;
  avatarUrl: string;
  reason: string;
}

export interface SourceOrganizationResult {
  organizations: GitOrg[];
  failedOrgs: SourceFailedOrganization[];
}

export interface SourceAccount {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface SourceRepositoryPath {
  owner: string;
  repo: string;
}

/**
 * The operations the mirror pipeline needs from a source host.
 *
 * Every method returns the shared GitRepo / GitOrg shapes with
 * `sourceProvider` and `sourceUrl` already stamped, so callers can insert the
 * result without knowing which host it came from.
 */
export interface SourceProvider {
  readonly kind: SourceProviderKind;
  readonly connection: SourceConnection;

  /** Repositories the account owns, collaborates on, or reaches through orgs. */
  listRepositories(
    config: Partial<Config>,
    options?: ListRepositoriesOptions
  ): Promise<GitRepo[]>;

  /** Repositories the account has starred. */
  listStarredRepositories(config: Partial<Config>): Promise<GitRepo[]>;

  /** Organizations (GitLab: top level groups) the account belongs to. */
  listOrganizations(
    config: Partial<Config>,
    skipOrgNames?: Set<string>
  ): Promise<SourceOrganizationResult>;

  /** One organization by name, or null when it does not exist. */
  getOrganization(name: string): Promise<GitOrg | null>;

  /** Every repository in an organization the token can see. */
  listOrganizationRepositories(name: string): Promise<GitRepo[]>;

  /**
   * One repository, or null on a clean 404. Any other failure throws, so
   * callers that treat "gone" as destructive (cleanup) can fail safe.
   */
  getRepository(owner: string, name: string): Promise<GitRepo | null>;

  /** Whether the account currently stars the repository. Throws on errors other than 404. */
  isRepositoryStarred(owner: string, name: string): Promise<boolean>;

  /** Verify the token and return the account it belongs to. */
  testConnection(): Promise<SourceAccount>;

  /**
   * Turn the path segments of a pasted URL into owner and repository names
   * the host understands. GitLab nests groups, so "group/sub/project" keeps
   * "group/sub" as the owner. Returns null when the segments name no repo.
   */
  resolveRepositoryPath(segments: string[]): SourceRepositoryPath | null;
}
