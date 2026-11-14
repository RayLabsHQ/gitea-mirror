/**
 * The source hosts Gitea Mirror can pull repositories from.
 *
 * Kept free of imports so both server code and client components can use it.
 * "gitea" covers Gitea and Forgejo (and therefore Codeberg): they share the
 * same API surface. "git" is any host that serves a repository over http(s)
 * and has no API this app knows: repositories are added one clone URL at a
 * time and only the code is mirrored (#514).
 */
export const SOURCE_PROVIDER_KINDS = ["github", "gitlab", "gitea", "git"] as const;

export type SourceProviderKind = (typeof SOURCE_PROVIDER_KINDS)[number];

export const DEFAULT_SOURCE_PROVIDER: SourceProviderKind = "github";

/** Sources other than GitHub are beta: they work end to end but have had less time in the field. */
export function isBetaSourceProvider(kind: SourceProviderKind): boolean {
  return kind !== DEFAULT_SOURCE_PROVIDER;
}

/**
 * Sources whose API can list releases with their assets.
 *
 * GitHub has always been able to. Gitea and Forgejo expose the same shape at
 * `GET /repos/{owner}/{repo}/releases`, so Codeberg and self hosted instances
 * can mirror releases too (#440). GitLab is code only: its release API is not
 * wired up, so the resolver still forces releases off for it.
 */
export const RELEASE_CAPABLE_SOURCE_KINDS = [
  "github",
  "gitea",
] as const satisfies readonly SourceProviderKind[];

/** True when a source kind's API can list releases. Unknown values are GitHub rows. */
export function sourceKindSupportsReleases(kind: unknown): boolean {
  return (RELEASE_CAPABLE_SOURCE_KINDS as readonly string[]).includes(
    normalizeSourceProviderKind(kind)
  );
}

/**
 * Sources with an account to list: repositories, organizations and stars can
 * be discovered, and a repository missing from the listing may have been
 * deleted upstream. A plain git host has none of that.
 */
export function sourceKindListsRepositories(kind: unknown): boolean {
  return normalizeSourceProviderKind(kind) !== "git";
}

/**
 * Base URL used when the config has no instance URL for the provider. A plain
 * git source has no default host: its URL is required.
 */
export const SOURCE_PROVIDER_DEFAULT_URLS: Record<SourceProviderKind, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  gitea: "https://codeberg.org",
  git: "",
};

export const SOURCE_PROVIDER_LABELS: Record<SourceProviderKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea / Forgejo",
  git: "Git URL",
};

/** What the host calls a group of repositories owned by a team. */
export const SOURCE_PROVIDER_ORG_NOUNS: Record<SourceProviderKind, string> = {
  github: "organization",
  gitlab: "group",
  gitea: "organization",
  git: "organization",
};

export function isSourceProviderKind(value: unknown): value is SourceProviderKind {
  return (
    typeof value === "string" &&
    (SOURCE_PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Org names are a single path segment on every source. GitLab nests groups,
 * but projects flatten onto the top level group, so a nested name would
 * import an organization whose repositories never match it.
 */
export function isValidSourceOrgName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !trimmed.includes("/");
}

/**
 * Coerce an untrusted value to a provider kind, defaulting to GitHub.
 * "forgejo" and "codeberg" are accepted as spellings of the Gitea kind.
 */
export function normalizeSourceProviderKind(value: unknown): SourceProviderKind {
  if (isSourceProviderKind(value)) return value;
  if (value === "forgejo" || value === "codeberg") return "gitea";
  return DEFAULT_SOURCE_PROVIDER;
}

/**
 * Normalize an instance URL: trim, add https:// when the scheme is missing,
 * lowercase the host, drop trailing slashes. Falls back to the provider's
 * default when the value is empty or unparseable.
 */
export function normalizeSourceUrl(
  raw: string | null | undefined,
  provider: SourceProviderKind
): string {
  const fallback = SOURCE_PROVIDER_DEFAULT_URLS[provider];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return fallback;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return fallback;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fallback;
  }

  // A plain git source stands for the whole host: each repository carries
  // its own path, so whatever path was pasted with the host is dropped.
  if (provider === "git") {
    return `${url.protocol}//${url.host}`;
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** True when the URL parses as an http(s) URL. Used by config validation. */
export function isValidSourceUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Hostname of a normalized source URL, for comparing pasted repository URLs. */
export function sourceHostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** The two columns a stored repository carries about its origin. */
export interface RepositorySourceFields {
  sourceProvider?: string | null;
  sourceUrl?: string | null;
}

export interface RepositorySource {
  provider: SourceProviderKind;
  url: string;
}

/** Where a stored repository came from. Rows from before this column default to GitHub. */
export function getRepositorySource(repo: RepositorySourceFields): RepositorySource {
  const provider = normalizeSourceProviderKind(repo.sourceProvider);
  return { provider, url: normalizeSourceUrl(repo.sourceUrl, provider) };
}

export function isRepositoryFromConfiguredSource(
  repo: RepositorySourceFields,
  connection: RepositorySource
): boolean {
  const source = getRepositorySource(repo);
  return source.provider === connection.provider && source.url === connection.url;
}

export function describeSource(source: RepositorySource): string {
  return `${SOURCE_PROVIDER_LABELS[source.provider]} (${source.url})`;
}
