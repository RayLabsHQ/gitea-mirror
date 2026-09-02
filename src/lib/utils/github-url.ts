/**
 * Parsing for the GitHub references people paste into the add dialogs.
 *
 * Accepts what someone actually has on their clipboard: a browser URL, a clone
 * URL, an SSH remote, or the `owner/repo` shorthand. Deep links are fine too,
 * since the owner and repo sit at the front of the path and everything after
 * them (tree/blob/issues/...) is noise for our purposes.
 */

/** Path segments that follow github.com but are not an account name. */
const RESERVED_ROOT_SEGMENTS = new Set([
  "about",
  "apps",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "notifications",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "signup",
  "sponsors",
  "topics",
  "trending",
]);

/** Trailing segments GitHub appends to a repo URL that we can safely ignore. */
const GIT_SUFFIX = /\.git$/i;

function stripWrapping(input: string): string {
  // Markdown/angle-bracket wrapping survives a lot of copy-paste paths.
  return input
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

export interface RepoReferenceParts {
  /** Lowercased host of the pasted URL, or null for the owner/repo shorthand. */
  host: string | null;
  segments: string[];
}

/**
 * Reduce any accepted form to its host and path segments.
 * Returns null when the input is not a repository-shaped reference at all.
 */
export function parseRepoReferenceParts(input: string): RepoReferenceParts | null {
  let value = stripWrapping(input);
  if (!value) return null;
  let host: string | null = null;

  // git@github.com:owner/repo.git -> owner/repo.git
  const sshMatch = value.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/i);
  if (sshMatch) {
    host = sshMatch[1].toLowerCase();
    value = sshMatch[2];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/\s]+\.[^/\s]+\//.test(value)) {
    // A full URL, or a bare host like "github.com/owner/repo".
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return null;
    }
    host = url.host.toLowerCase();
    value = url.pathname;
  }

  const segments = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.length > 0 ? { host, segments } : null;
}

function toPathSegments(input: string): string[] | null {
  return parseRepoReferenceParts(input)?.segments ?? null;
}

/** Segments that start the "rest of the page" after owner/repo on a flat host. */
const FLAT_HOST_DEEP_LINK_MARKERS = new Set([
  "-",
  "actions",
  "blob",
  "branches",
  "commit",
  "commits",
  "compare",
  "issues",
  "projects",
  "pull",
  "pulls",
  "releases",
  "settings",
  "src",
  "tags",
  "tree",
  "wiki",
]);

/**
 * Best effort owner/repo split for a host other than github.com. GitLab
 * nests groups and marks deep links with a "-" segment; Gitea keeps a flat
 * owner/repo layout. The server re-resolves from the raw segments through
 * the configured source, so this only has to be good enough for the form.
 */
function splitNonGithubPath(segments: string[]): { owner: string; repo: string } | null {
  const marker = segments.indexOf("-");
  let path = marker === -1 ? segments : segments.slice(0, marker);
  if (marker === -1 && path.length > 2 && FLAT_HOST_DEEP_LINK_MARKERS.has(path[2].toLowerCase())) {
    path = path.slice(0, 2);
  }
  if (path.length < 2) return null;

  const repo = path[path.length - 1].replace(GIT_SUFFIX, "");
  const owner = path.slice(0, -1).join("/");
  if (!isUsableRepoName(repo) || !owner) return null;
  return { owner, repo };
}

function isUsableAccount(segment: string | undefined): segment is string {
  if (!segment) return false;
  if (RESERVED_ROOT_SEGMENTS.has(segment.toLowerCase())) return false;
  // GitHub account names: alphanumerics and hyphens.
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(segment);
}

function isUsableRepoName(segment: string | undefined): segment is string {
  if (!segment) return false;
  return /^[A-Za-z0-9._-]+$/.test(segment);
}

/**
 * Pull `{ owner, repo }` out of a repository reference.
 * Returns null when the input does not name a repository.
 */
export function parseGitHubRepoReference(
  input: string
): { owner: string; repo: string } | null {
  const parts = parseRepoReferenceParts(input);
  if (!parts) return null;
  const { host, segments } = parts;

  // /orgs/<name>/... never names a repository.
  if (segments[0]?.toLowerCase() === "orgs") return null;

  // Other hosts may nest the owner (GitLab groups) or use different reserved
  // paths, so they get the looser split.
  if (host && host !== "github.com" && !host.endsWith(".github.com")) {
    return splitNonGithubPath(segments);
  }

  const [owner, rawRepo] = segments;
  if (!isUsableAccount(owner)) return null;

  const repo = rawRepo?.replace(GIT_SUFFIX, "");
  if (!isUsableRepoName(repo)) return null;

  return { owner, repo };
}

/**
 * Pull an organization (or user) name out of an account reference.
 * Accepts the profile URL, the /orgs/ form, and a bare name.
 */
export function parseGitHubOwnerReference(input: string): string | null {
  const segments = toPathSegments(input);
  if (!segments) return null;

  const candidate =
    segments[0]?.toLowerCase() === "orgs" ? segments[1] : segments[0];

  return isUsableAccount(candidate) ? candidate : null;
}

/** True when the input looks like a URL rather than a plain name. */
export function looksLikeUrl(input: string): boolean {
  const value = stripWrapping(input);
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^git@/i.test(value) ||
    value.includes("/")
  );
}
