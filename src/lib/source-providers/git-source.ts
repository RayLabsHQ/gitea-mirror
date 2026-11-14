/**
 * Plain git source: any host that serves a repository over http(s) (#514).
 *
 * There is no API to talk to, so there is nothing to list: no account, no
 * organizations, no stars, no releases or issues. A repository is added one
 * clone URL at a time, and the only question this adapter can answer is "does
 * a git repository live at this URL", which it asks the way `git ls-remote`
 * does: GET <url>/info/refs?service=git-upload-pack.
 *
 * The source row stands for the host. Its optional username and password (or
 * token) are sent as HTTP basic auth, and handed to the destination for its
 * own fetches.
 */
import type { Config } from "@/lib/db/schema";
import type { GitOrg } from "@/types/organizations";
import type { GitRepo } from "@/types/Repository";
import { guardedFetch } from "@/lib/utils/outbound-url";
import { DEFAULT_SOURCE_TIMEOUT_MS, SourceApiError, stripGitSuffix } from "./http";
import type {
  ListRepositoriesOptions,
  SourceAccount,
  SourceConnection,
  SourceOrganizationResult,
  SourceProvider,
  SourceRepositoryPath,
} from "./types";

/** Used as the basic auth username when only a token was given. */
export const DEFAULT_GIT_AUTH_USERNAME = "git";

/**
 * How much of the ref advertisement is read. HEAD and the capabilities are in
 * the first line; a repository with a hundred thousand refs is not downloaded
 * to learn that it exists.
 */
const ADVERTISEMENT_PREFIX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;

const SMART_CONTENT_TYPE = "application/x-git-upload-pack-advertisement";

export interface GitRemoteInfo {
  /** Branch HEAD points at, when the server says. */
  defaultBranch: string | null;
}

/**
 * Read what a ref advertisement says about HEAD. `null` means the body is not
 * a ref advertisement at all, which is how a web page answering 200 for any
 * path is told apart from a repository.
 */
export function parseRefAdvertisement(
  body: string,
  contentType: string | null
): GitRemoteInfo | null {
  const smart = (contentType ?? "").toLowerCase().startsWith(SMART_CONTENT_TYPE);

  if (smart || /^[0-9a-f]{4}# service=git-upload-pack/.test(body)) {
    // Smart HTTP: the first ref line carries the capabilities, and
    // `symref=HEAD:refs/heads/<branch>` names the default branch.
    const symref = body.match(/symref=HEAD:refs\/heads\/([^\s\0]+)/);
    return { defaultBranch: symref ? symref[1] : null };
  }

  // Dumb HTTP: "<object id>\t<ref name>" per line, no HEAD.
  const lines = body.split("\n").filter((line) => line.length > 0);
  if (
    lines.length > 0 &&
    lines.slice(0, 5).every((line) => /^[0-9a-f]{40,64}\t\S+/.test(line))
  ) {
    return { defaultBranch: null };
  }

  return null;
}

/** Path segments of a clone URL, without the `.git` on the last one. */
export function resolveGitRepositoryPath(
  segments: string[],
  host: string
): SourceRepositoryPath | null {
  const path = segments.map((segment) => segment.trim()).filter(Boolean);
  if (path.length === 0) return null;

  const repo = stripGitSuffix(path[path.length - 1]);
  if (!repo) return null;

  // A repository at the root of the host has no parent to call its owner, so
  // the host stands in.
  const owner = path.length > 1 ? path.slice(0, -1).join("/") : host;
  if (!owner) return null;

  return { owner, repo };
}

interface ProbeResult {
  status: number;
  info: GitRemoteInfo | null;
}

export class GitSourceProvider implements SourceProvider {
  readonly kind = "git" as const;
  /** Hostname without the port: usable as an owner name on the destination. */
  private readonly hostname: string;

  constructor(
    readonly connection: SourceConnection,
    /** Tests pass the runtime's own fetch, past whatever replaced the global one. */
    private readonly options: { fetchImpl?: typeof fetch } = {}
  ) {
    let hostname = "";
    try {
      hostname = new URL(connection.url).hostname.toLowerCase();
    } catch {
      // An unusable URL fails every request below with a clear error.
    }
    this.hostname = hostname;
  }

  private get authorization(): string | null {
    const token = this.connection.token.trim();
    if (!token) return null;
    const username = this.connection.username.trim() || DEFAULT_GIT_AUTH_USERNAME;
    return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  }

  /** Fetch the start of a URL as text, then close the connection. */
  private async fetchPrefix(
    url: string,
    authorization: string | null
  ): Promise<{ status: number; contentType: string | null; body: string }> {
    // Aborting is what closes the socket; cancelling the body alone leaves
    // Bun reading whatever the server keeps sending.
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(DEFAULT_SOURCE_TIMEOUT_MS),
    ]);

    try {
      const response = await guardedFetch(
        url,
        {
          method: "GET",
          headers: {
            Accept: "*/*",
            "User-Agent": "git/2.0 (gitea-mirror)",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          signal,
        },
        { maxRedirects: MAX_REDIRECTS, fetchImpl: this.options.fetchImpl }
      );

      const contentType = response.headers.get("content-type");
      if (!response.ok || !response.body) {
        return { status: response.status, contentType, body: "" };
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (received < ADVERTISEMENT_PREFIX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
      }

      const body = Buffer.concat(chunks)
        .subarray(0, ADVERTISEMENT_PREFIX_BYTES)
        .toString("latin1");
      return { status: response.status, contentType, body };
    } finally {
      controller.abort();
    }
  }

  /** Ask one clone URL for its refs, the way `git ls-remote` starts. */
  private async probe(cloneUrl: string, authorization: string | null): Promise<ProbeResult> {
    const { status, contentType, body } = await this.fetchPrefix(
      `${cloneUrl}/info/refs?service=git-upload-pack`,
      authorization
    );
    if (status < 200 || status >= 300) return { status, info: null };

    const info = parseRefAdvertisement(body, contentType);
    // 200 with something that is not a ref listing: no repository here.
    if (!info) return { status: 404, info: null };

    if (!info.defaultBranch) {
      info.defaultBranch = await this.readHeadFile(cloneUrl, authorization);
    }
    return { status, info };
  }

  /** Dumb HTTP servers expose the HEAD file itself: "ref: refs/heads/<branch>". */
  private async readHeadFile(cloneUrl: string, authorization: string | null): Promise<string | null> {
    try {
      const { status, body } = await this.fetchPrefix(`${cloneUrl}/HEAD`, authorization);
      if (status !== 200) return null;
      const match = body.match(/^ref: refs\/heads\/(\S+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async listRepositories(
    _config: Partial<Config>,
    _options?: ListRepositoriesOptions
  ): Promise<GitRepo[]> {
    return [];
  }

  async listStarredRepositories(_config: Partial<Config>): Promise<GitRepo[]> {
    return [];
  }

  async listOrganizations(_config: Partial<Config>): Promise<SourceOrganizationResult> {
    return { organizations: [], failedOrgs: [] };
  }

  async getOrganization(_name: string): Promise<GitOrg | null> {
    return null;
  }

  async listOrganizationRepositories(_name: string): Promise<GitRepo[]> {
    return [];
  }

  /**
   * `owner` is the path in front of the repository (or the host for a
   * repository at the root), `name` the last segment without `.git`. Both
   * spellings of the clone URL are tried, without credentials first, so a
   * repository anybody can read is recorded as public.
   */
  async getRepository(owner: string, name: string): Promise<GitRepo | null> {
    const repoName = stripGitSuffix(name.trim());
    const parent = owner
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (!repoName) return null;

    const atRoot = parent.length === 1 && parent[0].toLowerCase() === this.hostname;
    const pathSegments = atRoot ? [repoName] : [...parent, repoName];
    if (pathSegments.some((segment) => segment === "." || segment === "..")) return null;

    const basePath = pathSegments.map(encodeURIComponent).join("/");
    const candidates = [
      `${this.connection.url}/${basePath}.git`,
      `${this.connection.url}/${basePath}`,
    ];
    const credentials = this.authorization;
    const attempts: Array<string | null> = credentials ? [null, credentials] : [null];

    let refused: { status: number; url: string } | null = null;

    for (const authorization of attempts) {
      for (const cloneUrl of candidates) {
        const result = await this.probe(cloneUrl, authorization);
        if (result.info) {
          const fullName = atRoot
            ? `${this.hostname}/${repoName}`
            : `${parent.join("/")}/${repoName}`;
          const now = new Date();
          return {
            name: repoName,
            fullName,
            url: cloneUrl,
            cloneUrl,

            // The folder the repository sits in, which is the closest thing a
            // plain git host has to an owner and a usable name on the
            // destination.
            owner: atRoot ? this.hostname : parent[parent.length - 1],
            sourceProvider: "git",
            sourceUrl: this.connection.url,
            mirroredLocation: "",
            destinationOrg: null,

            isPrivate: authorization !== null,
            isForked: false,

            hasIssues: false,
            isStarred: false,
            isArchived: false,

            size: 0,
            hasLFS: false,
            hasSubmodules: false,

            language: null,
            description: null,
            defaultBranch: result.info.defaultBranch || "main",
            visibility: authorization !== null ? "private" : "public",

            status: "imported",

            importedAt: now,
            createdAt: now,
            updatedAt: now,
          };
        }
        if (result.status === 401 || result.status === 403) {
          refused = { status: result.status, url: cloneUrl };
        } else if (result.status !== 404 && result.status !== 410) {
          throw new SourceApiError(
            `Request to ${cloneUrl} failed with status ${result.status}`,
            result.status,
            cloneUrl
          );
        }
      }
    }

    if (refused) {
      throw new SourceApiError(
        credentials
          ? `${refused.url} refused the username and password of this source`
          : `${refused.url} was not served without a login`,
        refused.status,
        refused.url
      );
    }
    return null;
  }

  async isRepositoryStarred(_owner: string, _name: string): Promise<boolean> {
    return false;
  }

  /**
   * There is no account to ask about. Reaching the host at all is the test:
   * any HTTP answer counts, since most git hosts have nothing at their root.
   */
  async testConnection(): Promise<SourceAccount> {
    if (!this.hostname) {
      throw new Error("A host URL is required, for example https://git.example.org");
    }
    await this.fetchPrefix(`${this.connection.url}/`, null);
    return { login: this.connection.username.trim() || this.hostname, name: null, avatarUrl: null };
  }

  resolveRepositoryPath(segments: string[]): SourceRepositoryPath | null {
    return resolveGitRepositoryPath(segments, this.hostname);
  }
}
