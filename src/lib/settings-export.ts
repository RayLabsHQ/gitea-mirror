/**
 * Settings export (#587): what a new instance needs to be set up the same
 * way, as JSON that reads well and diffs cleanly under git.
 *
 * Left out on purpose:
 * - credentials: tokens, passwords, secrets, GitHub App keys, webhook URLs
 *   (Slack and Discord put the credential in the URL) and the user:password
 *   part of any URL;
 * - run state: the scheduler's and cleanup's last and next run, mirror
 *   status, errors, sizes, timestamps and ids, which differ per instance;
 * - accounts, SSO providers, API keys and OAuth applications.
 *
 * The output is stable: object keys are sorted, lists of sources,
 * organizations and repositories are sorted, and nothing in it depends on
 * when it was made, so two exports of an unchanged instance are identical.
 */
import { isGitHubAppCredential } from "@/lib/github-app-credentials";
import { listOverriddenKeys } from "@/lib/utils/mirror-overrides";

export const SETTINGS_EXPORT_FORMAT = "gitea-mirror-settings";
export const SETTINGS_EXPORT_VERSION = 1;

const NOTE =
  "Tokens, passwords, secrets and webhook URLs are not exported. Enter them again on a new instance.";

/** Keys that hold a credential, dropped wherever they appear in the settings. */
const SECRET_KEYS = new Set(["token", "secret", "password", "clientsecret", "privatekey", "apikey"]);

/** Run state written back into the settings, per settings section. */
const STATE_KEYS: Record<string, readonly string[]> = {
  scheduleConfig: ["lastRun", "nextRun"],
  cleanupConfig: ["lastRun", "nextRun"],
};

/** The settings sections of a configs row, by their stored names. */
const SETTINGS_SECTIONS = [
  "githubConfig",
  "giteaConfig",
  "include",
  "exclude",
  "scheduleConfig",
  "cleanupConfig",
  "notificationConfig",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface SettingsExportInput {
  config: Partial<Record<SettingsSection, unknown>> | null;
  sources: Array<{
    name: string;
    provider: string;
    url: string;
    username?: string | null;
    token?: string | null;
    enabled?: boolean | null;
    id: string;
  }>;
  organizations: Array<{
    name: string;
    sourceId?: string | null;
    isIncluded?: boolean | null;
    status?: string | null;
    destinationOrg?: string | null;
    mirrorOverrides?: unknown;
  }>;
  repositories: Array<{
    fullName: string;
    sourceId?: string | null;
    status?: string | null;
    destinationOrg?: string | null;
    mirrorOverrides?: unknown;
  }>;
  /** List every tracked repository, not only the ones with a choice of their own. */
  allRepositories?: boolean;
  appVersion?: string | null;
  /**
   * Decrypts a stored source token. Only used to tell a GitHub App apart
   * from a token; the value never reaches the output.
   */
  decryptToken?: (stored: string) => string;
}

/** Something that starts like a URL: optional leading space, then a scheme and a colon. */
const SCHEME_PREFIX = /^[\s\x00-\x1f]*[a-z][a-z0-9+.-]*:[/\\]*/i;

/**
 * Drop the user:password part of a URL.
 *
 * The URL parser decides what the user info is, since that is what a
 * request made with the value would send: it takes the last "@", accepts
 * spaces, extra or missing slashes and backslashes, and drops tabs and
 * newlines. A URL that carries user info is rebuilt from the parse without
 * it (so it comes out normalized); anything else is returned as written. A
 * string that starts like a URL but does not parse can still hold a
 * password with "/", "?" or "#" in it, so there everything after the scheme
 * up to the last "@" goes.
 */
export function withoutUserInfo(value: string): string {
  if (!value.includes("@") || !SCHEME_PREFIX.test(value)) return value;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // Handled below.
  }
  if (url) {
    if (!url.username && !url.password) return value;
    url.username = "";
    url.password = "";
    let out = url.href;
    // Keep "https://host" as written instead of the parser's "https://host/".
    if (url.pathname === "/" && !url.search && !url.hash && !value.trim().endsWith("/") && out.endsWith("/")) {
      out = out.slice(0, -1);
    }
    return out;
  }
  const prefix = SCHEME_PREFIX.exec(value)![0];
  const rest = value.slice(prefix.length);
  return prefix.trimStart() + rest.slice(rest.lastIndexOf("@") + 1);
}

/** A copy with credentials removed and URLs cleaned, at any depth. */
function scrub(value: unknown): unknown {
  if (typeof value === "string") return withoutUserInfo(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase())) continue;
      if (child === undefined) continue;
      out[key] = scrub(child);
    }
    return out;
  }
  return value;
}

/** Sort object keys at every depth so the same settings always print the same. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** One settings section, with credentials and run state removed. */
function exportSection(section: SettingsSection, raw: unknown): unknown {
  const value = scrub(parseJson(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? null;
  const out = { ...(value as Record<string, unknown>) };
  for (const key of STATE_KEYS[section] ?? []) delete out[key];
  if (section === "notificationConfig" && out.webhook && typeof out.webhook === "object") {
    const { url: _url, ...webhook } = out.webhook as Record<string, unknown>;
    out.webhook = webhook;
  }
  return out;
}

/**
 * How organizations and repositories name their source in the file: provider,
 * URL and username, which is what makes a source unique, unlike its name.
 */
export function sourceReference(source: { provider: string; url: string; username?: string | null }): string {
  const username = source.username?.trim();
  return `${source.provider} ${withoutUserInfo(source.url)}${username ? ` ${username}` : ""}`;
}

function sourceAuthentication(
  source: SettingsExportInput["sources"][number],
  decryptToken?: (stored: string) => string
): "none" | "token" | "password" | "github-app" {
  if (!source.token) return "none";
  if (source.provider === "git") return "password";
  if (source.provider === "github" && decryptToken) {
    try {
      if (isGitHubAppCredential(decryptToken(source.token))) return "github-app";
    } catch {
      // An unreadable token is still a token.
    }
  }
  return "token";
}

/** The overrides a row pins, or undefined when it pins nothing. */
function exportOverrides(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  if (listOverriddenKeys(parsed).length === 0) return undefined;
  const scrubbed = scrub(parsed) as Record<string, unknown>;
  // Unset keys (null) are noise in a diff.
  return Object.fromEntries(Object.entries(scrubbed).filter(([, v]) => v !== null));
}

const byText = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" }) || a.localeCompare(b);

export function buildSettingsExport(input: SettingsExportInput): Record<string, unknown> {
  const references = new Map(input.sources.map((source) => [source.id, sourceReference(source)]));
  const referenceOf = (sourceId?: string | null) => (sourceId ? references.get(sourceId) ?? null : null);

  const sources = input.sources
    .map((source) => ({
      reference: sourceReference(source),
      name: source.name,
      provider: source.provider,
      url: withoutUserInfo(source.url),
      username: source.username?.trim() || null,
      enabled: source.enabled !== false,
      authentication: sourceAuthentication(source, input.decryptToken),
    }))
    .sort((a, b) => byText(a.reference, b.reference));

  const settings: Record<string, unknown> = {};
  for (const section of SETTINGS_SECTIONS) {
    if (input.config && section in input.config) {
      settings[section] = exportSection(section, input.config[section]);
    }
  }

  const organizations = input.organizations
    .map((org) => {
      const entry: Record<string, unknown> = {
        name: org.name,
        source: referenceOf(org.sourceId),
        included: org.isIncluded !== false,
      };
      if (org.status === "ignored") entry.ignored = true;
      if (org.destinationOrg?.trim()) entry.destinationOrg = org.destinationOrg.trim();
      const overrides = exportOverrides(org.mirrorOverrides);
      if (overrides) entry.mirrorOverrides = overrides;
      return entry;
    })
    .sort((a, b) => byText(`${a.source ?? ""} ${a.name}`, `${b.source ?? ""} ${b.name}`));

  const repositories = input.repositories
    .map((repo) => {
      const entry: Record<string, unknown> = {
        fullName: repo.fullName,
        source: referenceOf(repo.sourceId),
      };
      if (repo.status === "ignored") entry.ignored = true;
      if (repo.destinationOrg?.trim()) entry.destinationOrg = repo.destinationOrg.trim();
      const overrides = exportOverrides(repo.mirrorOverrides);
      if (overrides) entry.mirrorOverrides = overrides;
      return entry;
    })
    // Without the full list, only rows that carry a choice of their own.
    .filter((entry) => input.allRepositories || Object.keys(entry).length > 2)
    .sort((a, b) =>
      byText(`${a.source ?? ""} ${a.fullName}`, `${b.source ?? ""} ${b.fullName}`)
    );

  return {
    format: SETTINGS_EXPORT_FORMAT,
    version: SETTINGS_EXPORT_VERSION,
    ...(input.appVersion && input.appVersion !== "unknown" ? { appVersion: input.appVersion } : {}),
    note: NOTE,
    repositoryList: input.allRepositories ? "all" : "with-choices",
    sources: sortKeys(sources),
    settings: sortKeys(settings),
    organizations: sortKeys(organizations),
    repositories: sortKeys(repositories),
  };
}

/** The file contents: two space indent and a final newline, like a hand-kept file. */
export function serializeSettingsExport(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function settingsExportFilename(now: Date): string {
  return `gitea-mirror-settings-${now.toISOString().slice(0, 10)}.json`;
}
