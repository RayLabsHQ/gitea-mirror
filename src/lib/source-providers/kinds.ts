/**
 * The source hosts Gitea Mirror can pull repositories from.
 *
 * Kept free of imports so both server code and client components can use it.
 * "gitea" covers Gitea and Forgejo (and therefore Codeberg): they share the
 * same API surface.
 */
export const SOURCE_PROVIDER_KINDS = ["github", "gitlab", "gitea"] as const;

export type SourceProviderKind = (typeof SOURCE_PROVIDER_KINDS)[number];

export const DEFAULT_SOURCE_PROVIDER: SourceProviderKind = "github";

/** Base URL used when the config has no instance URL for the provider. */
export const SOURCE_PROVIDER_DEFAULT_URLS: Record<SourceProviderKind, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  gitea: "https://codeberg.org",
};

export const SOURCE_PROVIDER_LABELS: Record<SourceProviderKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea / Forgejo",
};

/** What the host calls a group of repositories owned by a team. */
export const SOURCE_PROVIDER_ORG_NOUNS: Record<SourceProviderKind, string> = {
  github: "organization",
  gitlab: "group",
  gitea: "organization",
};

export function isSourceProviderKind(value: unknown): value is SourceProviderKind {
  return (
    typeof value === "string" &&
    (SOURCE_PROVIDER_KINDS as readonly string[]).includes(value)
  );
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
