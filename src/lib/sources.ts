/**
 * Source rows: the connected hosts a user pulls repositories from.
 *
 * The sources table is the authoritative home for source connections
 * (provider, instance URL, username, token). The legacy
 * configs.githubConfig connection fields stay synchronized with the FIRST
 * source row (the "primary" source, oldest first) so un-migrated readers and
 * the existing truthiness gates keep working: zero sources means empty
 * connection fields, which reads as "not configured".
 *
 * Tokens are stored AES-256-GCM encrypted, the same convention as
 * configs.githubConfig.token, and copied between the two storages without
 * re-encrypting. The database module is imported lazily (the same pattern as
 * loadConfigLocks) so per-test-file module mocks keep working.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { sources } from "@/lib/db/schema";
import { decrypt, encrypt } from "@/lib/utils/encryption";
import {
  SOURCE_PROVIDER_KINDS,
  SOURCE_PROVIDER_LABELS,
  getRepositorySource,
  isSourceProviderKind,
  normalizeSourceProviderKind,
  normalizeSourceUrl,
  type RepositorySourceFields,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";

/** A row of the sources table, as stored (token still encrypted). */
export type SourceRecord = typeof sources.$inferSelect;

/** The result of findSourceForRepository: the matched row, or null when none matches. */
export type SourceConnectionForRepo = SourceRecord | null;

/** Input for createSource. The provider is validated strictly, not coerced. */
export interface SourceInput {
  provider: unknown;
  url?: string | null;
  username?: string | null;
  token?: string | null;
  name?: string | null;
  enabled?: boolean;
}

/** Input for updateSource: every field optional, absent means "keep". */
export type SourceUpdateInput = Partial<SourceInput>;

/** Create refused because this (provider, url, username) is already connected. */
export class DuplicateSourceError extends Error {
  readonly code = "duplicate_source";

  constructor(label: string) {
    super(`${label} is already connected. Remove it first to re-add or change it.`);
    this.name = "DuplicateSourceError";
  }
}

/** The display label for a source: "GitHub (octocat)", or just the provider label without a username. */
export function deriveSourceName(provider: SourceProviderKind, username: string): string {
  const label = SOURCE_PROVIDER_LABELS[provider];
  return username ? `${label} (${username})` : label;
}

function requireProviderKind(value: unknown, label: string): SourceProviderKind {
  if (!isSourceProviderKind(value)) {
    throw new Error(
      `Unknown source provider ${JSON.stringify(value)} for ${label}. Supported providers: ${SOURCE_PROVIDER_KINDS.join(", ")}.`
    );
  }
  return value;
}

/** All of a user's sources, oldest first (index 0 is the primary source). */
export async function listSources(userId: string): Promise<SourceRecord[]> {
  const { db } = await import("@/lib/db");
  const rows = await db
    .select()
    .from(sources)
    .where(eq(sources.userId, userId));
  // Sorted in JS rather than SQL so shallow test doubles of the database
  // (which resolve the query at .where()) keep working.
  const list = Array.isArray(rows) ? rows : [];
  return list.sort(
    (a, b) => (+a.createdAt || 0) - (+b.createdAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The first entry of listSources(userId), or null when nothing is connected. */
export function primarySource(list: SourceRecord[]): SourceRecord | null {
  return list.length > 0 ? list[0] : null;
}

function duplicateLabel(provider: SourceProviderKind, url: string, username: string): string {
  return `${SOURCE_PROVIDER_LABELS[provider]} (${url})${username ? ` for ${username}` : ""}`;
}

async function assertNoDuplicate(
  userId: string,
  provider: SourceProviderKind,
  url: string,
  username: string,
  excludeId?: string
): Promise<void> {
  const { db } = await import("@/lib/db");
  const conditions = [
    eq(sources.userId, userId),
    eq(sources.provider, provider),
    eq(sources.url, url),
    eq(sources.username, username),
  ];
  if (excludeId) conditions.push(ne(sources.id, excludeId));

  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(...conditions))
    .limit(1);
  if (existing) {
    throw new DuplicateSourceError(duplicateLabel(provider, url, username));
  }
}

async function selectSource(userId: string, sourceId: string): Promise<SourceRecord> {
  const { db } = await import("@/lib/db");
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .limit(1);
  if (!row) {
    throw new Error(`Source ${sourceId} not found for user ${userId}`);
  }
  return row;
}

export type DanglingRepositoryRow = {
  id: string;
  sourceId?: string | null;
  sourceProvider?: string | null;
  sourceUrl?: string | null;
  normalizedFullName: string | null;
  updatedAt: Date | string | null;
};

// Repositories whose sourceId no longer resolves (or was never set) but whose
// provider and host match the given source: exactly the rows a deleted and
// re-added source must take back. Without the re-link, the next import sees
// them as new (NULL and dangling ids never equal the new source's id, and
// SQLite treats NULLs as distinct in the unique index) and duplicates them.
// Rows are deduplicated by name: relinking two same-name rows onto one source
// would violate uniq_repositories_user_source_normalized_full_name, so only
// the most recently updated row per name is taken back and the losers are
// returned separately for manual cleanup.
export function selectRepositoriesToRelink(
  rows: DanglingRepositoryRow[],
  connectedSourceIds: Set<string>,
  provider: SourceProviderKind,
  url: string
): { relinkIds: string[]; duplicateIds: string[] } {
  const matches = rows.filter((row) => {
    if (row.sourceId && connectedSourceIds.has(row.sourceId)) return false;
    const normalized = getRepositorySource({ sourceProvider: row.sourceProvider, sourceUrl: row.sourceUrl });
    return normalized.provider === provider && normalized.url === url;
  });

  const winnerByName = new Map<string, DanglingRepositoryRow>();
  for (const row of matches) {
    const name = (row.normalizedFullName ?? "").trim();
    const key = name || `id:${row.id}`;
    const current = winnerByName.get(key);
    if (!current || +new Date(row.updatedAt ?? 0) > +new Date(current.updatedAt ?? 0)) {
      winnerByName.set(key, row);
    }
  }

  const winnerIds = new Set([...winnerByName.values()].map((row) => row.id));
  return {
    relinkIds: [...winnerIds],
    duplicateIds: matches.filter((row) => !winnerIds.has(row.id)).map((row) => row.id),
  };
}

async function relinkRepositoriesToSource(
  userId: string,
  sourceId: string,
  provider: SourceProviderKind,
  url: string
): Promise<void> {
  const { db, repositories } = await import("@/lib/db");
  const connected = await db.select({ id: sources.id }).from(sources).where(eq(sources.userId, userId));
  const connectedIds = new Set(connected.map((row) => row.id));
  const rows = await db
    .select({
      id: repositories.id,
      sourceId: repositories.sourceId,
      sourceProvider: repositories.sourceProvider,
      sourceUrl: repositories.sourceUrl,
      normalizedFullName: repositories.normalizedFullName,
      updatedAt: repositories.updatedAt,
    })
    .from(repositories)
    .where(eq(repositories.userId, userId));
  const { relinkIds, duplicateIds } = selectRepositoriesToRelink(rows, connectedIds, provider, url);
  if (duplicateIds.length > 0) {
    console.warn(
      `[sources] ${duplicateIds.length} duplicate repositories already occupy a name on this source; leaving them dangling for manual cleanup`
    );
  }
  if (relinkIds.length === 0) return;
  await db
    .update(repositories)
    .set({ sourceId, updatedAt: new Date() })
    .where(and(eq(repositories.userId, userId), inArray(repositories.id, [...relinkIds])));
}

export async function createSource(userId: string, input: SourceInput): Promise<SourceRecord> {
  const provider = requireProviderKind(input.provider, "the new source");
  const url = normalizeSourceUrl(input.url, provider);
  const username = (input.username ?? "").trim();
  const rawToken = (input.token ?? "").trim();
  const name = input.name?.trim() || deriveSourceName(provider, username);

  await assertNoDuplicate(userId, provider, url, username);

  const { db } = await import("@/lib/db");
  const id = uuidv4();
  await db.insert(sources).values({
    id,
    userId,
    name,
    provider,
    url,
    username,
    token: rawToken ? encrypt(rawToken) : null,
    enabled: input.enabled ?? true,
  });

  await relinkRepositoriesToSource(userId, id, provider, url);
  await syncPrimarySourceToConfig(userId);
  return selectSource(userId, id);
}

export async function updateSource(
  userId: string,
  sourceId: string,
  input: SourceUpdateInput
): Promise<SourceRecord> {
  const existing = await selectSource(userId, sourceId);

  const provider =
    input.provider === undefined
      ? existing.provider
      : requireProviderKind(input.provider, `source ${sourceId}`);
  // A provider switch re-normalizes the stored URL against the new provider
  // (the default of the old provider must not carry over as a custom URL);
  // an explicit URL always wins.
  const url =
    input.url !== undefined
      ? normalizeSourceUrl(input.url, provider)
      : provider === existing.provider
        ? existing.url
        : normalizeSourceUrl(existing.url, provider);
  const username = (input.username ?? existing.username).trim();
  const rawToken = (input.token ?? "").trim();
  const name =
    input.name === undefined
      ? existing.name
      : input.name?.trim() || deriveSourceName(provider, username);
  const enabled = input.enabled ?? existing.enabled;

  if (
    provider !== existing.provider ||
    url !== existing.url ||
    username !== existing.username
  ) {
    await assertNoDuplicate(userId, provider, url, username, sourceId);
  }
  // Host edits deliberately do not re-link repositories (createSource does):
  // a host switch is lock-confirmed, and rows of the old host intentionally
  // stay dangling rather than silently following the source to the new host.

  const { db } = await import("@/lib/db");
  await db
    .update(sources)
    .set({
      name,
      provider,
      url,
      username,
      // An empty token on update keeps the stored one; only a non-empty
      // token replaces it (the config save convention).
      token: rawToken ? encrypt(rawToken) : existing.token,
      enabled,
      updatedAt: new Date(),
    })
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)));

  await syncPrimarySourceToConfig(userId);
  return selectSource(userId, sourceId);
}

export async function deleteSource(userId: string, sourceId: string): Promise<void> {
  await selectSource(userId, sourceId);

  const { db } = await import("@/lib/db");
  await db.delete(sources).where(and(eq(sources.id, sourceId), eq(sources.userId, userId)));

  // Repositories keep their sourceId on purpose (dangling by design).
  await syncPrimarySourceToConfig(userId);
}

/**
 * Write-through for the legacy config: mirror the FIRST source's connection
 * fields into configs.githubConfig, or clear them when nothing is connected.
 * The token is copied as-is (it is stored encrypted in both places).
 */
export async function syncPrimarySourceToConfig(userId: string): Promise<void> {
  const { db, configs } = await import("@/lib/db");
  const list = await listSources(userId);

  // Prefer active and most-recently-updated config to avoid picking a stale
  // inactive stub when multiple rows exist (see issue #271).
  const [config] = await db
    .select()
    .from(configs)
    .where(eq(configs.userId, userId))
    .orderBy(sql`${configs.isActive} desc`, sql`${configs.updatedAt} desc`)
    .limit(1);
  if (!config) return;

  const primary = primarySource(list);
  const githubConfig = { ...config.githubConfig };
  if (primary) {
    githubConfig.provider = primary.provider;
    githubConfig.url = primary.url;
    githubConfig.owner = primary.username;
    githubConfig.token = primary.token ?? "";
  } else {
    githubConfig.provider = "github";
    githubConfig.url = undefined;
    githubConfig.owner = "";
    githubConfig.token = "";
  }

  await db
    .update(configs)
    .set({ githubConfig, updatedAt: new Date() })
    .where(eq(configs.id, config.id));
}

/**
 * Idempotent bootstrap for configs written outside the sources API: when a
 * user has no source rows but their config carries connection fields
 * (POST /api/config from scripts, seed data), seed the first source row from
 * them so discovery and the scheduler find something to iterate. Mirrors the
 * 0019 migration: the token is copied encrypted as-is and the provider is
 * normalized (config blobs may still hold "forgejo"/"codeberg").
 */
export async function ensureSourcesFromConfig(userId: string): Promise<void> {
  const existing = await listSources(userId);
  if (existing.length > 0) return;

  const { db, configs } = await import("@/lib/db");
  const [config] = await db
    .select()
    .from(configs)
    .where(eq(configs.userId, userId))
    .orderBy(sql`${configs.isActive} desc`, sql`${configs.updatedAt} desc`)
    .limit(1);
  if (!config) return;

  const github = config.githubConfig;
  const username = (github?.owner ?? "").trim();
  const token = (github?.token ?? "").trim();
  if (!username && !token) return;

  const provider = normalizeSourceProviderKind(github?.provider);
  const url = normalizeSourceUrl(github?.url, provider);
  const sourceId = uuidv4();
  await db.insert(sources).values({
    id: sourceId,
    userId,
    name: deriveSourceName(provider, username),
    provider,
    url,
    username,
    token: token || null,
    enabled: true,
  });
  await relinkRepositoriesToSource(userId, sourceId, provider, url);
}

/**
 * The source a repository belongs to: the stored sourceId first, then a
 * provider + host match against the user's sources (so a deleted and
 * re-added source is found again). Null means the repository's host is not
 * connected, and mirroring it must be refused.
 */
export function findSourceForRepository(
  repo: RepositorySourceFields & { sourceId?: string | null },
  list: SourceRecord[]
): SourceConnectionForRepo {
  if (repo.sourceId) {
    const byId = list.find((source) => source.id === repo.sourceId);
    if (byId) return byId;
  }

  const source = getRepositorySource(repo);
  // Compare normalized URLs: rows seeded by the 0019 migration may hold
  // non-canonical URLs (rtrim-only) that still resolve once normalized.
  return (
    list.find(
      (candidate) =>
        candidate.provider === source.provider &&
        normalizeSourceUrl(candidate.url, candidate.provider) === source.url
    ) ?? null
  );
}

/**
 * Decrypt a source token for API use. Unlike getDecryptedGitHubToken this
 * never throws: empty or missing means public-only access, which every
 * source kind supports.
 */
export function decryptSourceToken(token: string | null | undefined): string {
  return token ? decrypt(token) : "";
}

/**
 * The REST API base for a GitHub-kind source. github.com (or empty) returns
 * undefined so the GH_API_URL environment default applies (GHES/GHEC setups
 * that predate multi-source keep working); any other URL is a GitHub
 * Enterprise instance addressed at <host>/api/v3.
 */
export function resolveGitHubApiBaseUrl(sourceUrl: string | null | undefined): string | undefined {
  const trimmed = sourceUrl?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed || trimmed === "https://github.com") return undefined;
  return `${trimmed}/api/v3`;
}
