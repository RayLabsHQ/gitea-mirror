/**
 * Source and destination locks.
 *
 * Once repositories have been imported, the source (provider and instance
 * URL) is locked; once anything has been mirrored, the destination (Gitea
 * server URL) is locked. Changing either afterwards is still possible, but
 * only with an explicit confirmation, so an autosave, a script or an
 * environment variable cannot switch hosts by accident.
 *
 * The decision logic is pure; the database lookup lives in loadConfigLocks.
 */
import type { ConfigLockState } from "@/types/config";
import {
  SOURCE_PROVIDER_DEFAULT_URLS,
  SOURCE_PROVIDER_LABELS,
  normalizeSourceProviderKind,
  normalizeSourceUrl,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";

export interface SourceIdentity {
  provider: SourceProviderKind;
  url: string;
}

export interface SourceLike {
  provider?: unknown;
  url?: string | null;
}

/** Statuses that mean a repository exists (or is being created) on the destination. */
export const MIRRORED_STATUSES = ["mirroring", "mirrored", "syncing", "synced"] as const;

export function computeConfigLocks({
  repositoryCount,
  mirroredCount,
}: {
  repositoryCount: number;
  mirroredCount: number;
}): ConfigLockState {
  return {
    source: { locked: repositoryCount > 0, repositoryCount },
    destination: { locked: mirroredCount > 0, mirroredCount },
  };
}

export const UNLOCKED_CONFIG: ConfigLockState = computeConfigLocks({
  repositoryCount: 0,
  mirroredCount: 0,
});

/** The host a source config points at, normalized so cosmetic edits do not count as a change. */
export function sourceIdentity(config: SourceLike | null | undefined): SourceIdentity {
  const provider = normalizeSourceProviderKind(config?.provider);
  return {
    provider,
    url:
      provider === "github"
        ? SOURCE_PROVIDER_DEFAULT_URLS.github
        : normalizeSourceUrl(config?.url, provider),
  };
}

export function describeSourceIdentity(identity: SourceIdentity): string {
  return `${SOURCE_PROVIDER_LABELS[identity.provider]} (${identity.url})`;
}

export function hasSourceChanged(
  existing: SourceLike | null | undefined,
  incoming: SourceLike | null | undefined
): boolean {
  const a = sourceIdentity(existing);
  const b = sourceIdentity(incoming);
  return a.provider !== b.provider || a.url !== b.url;
}

/** Normalize a Gitea server URL for comparison. Empty stays empty. */
export function normalizeDestinationUrl(url: string | null | undefined): string {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

/** An empty side means "not set yet", which is never a change. */
export function hasDestinationChanged(
  existingUrl: string | null | undefined,
  incomingUrl: string | null | undefined
): boolean {
  const a = normalizeDestinationUrl(existingUrl);
  const b = normalizeDestinationUrl(incomingUrl);
  if (!a || !b) return false;
  return a !== b;
}

export type ConfigChangeVerdict =
  | { ok: true }
  | { ok: false; lock: "source" | "destination"; message: string };

/**
 * Decide whether a save may go through. The source is checked first: a
 * request that changes both without confirming either is refused for the
 * source, and the destination is reported on the next attempt.
 */
export function evaluateConfigChange({
  locks,
  existingSource,
  incomingSource,
  existingDestinationUrl,
  incomingDestinationUrl,
  confirmSourceChange = false,
  confirmDestinationChange = false,
}: {
  locks: ConfigLockState;
  existingSource: SourceLike | null | undefined;
  incomingSource: SourceLike | null | undefined;
  existingDestinationUrl: string | null | undefined;
  incomingDestinationUrl: string | null | undefined;
  confirmSourceChange?: boolean;
  confirmDestinationChange?: boolean;
}): ConfigChangeVerdict {
  if (
    locks.source.locked &&
    !confirmSourceChange &&
    hasSourceChanged(existingSource, incomingSource)
  ) {
    const count = locks.source.repositoryCount;
    return {
      ok: false,
      lock: "source",
      message:
        `The source is locked: ${count} ${count === 1 ? "repository was" : "repositories were"} imported from ` +
        `${describeSourceIdentity(sourceIdentity(existingSource))}. ` +
        `Confirm the change to switch to ${describeSourceIdentity(sourceIdentity(incomingSource))}.`,
    };
  }

  if (
    locks.destination.locked &&
    !confirmDestinationChange &&
    hasDestinationChanged(existingDestinationUrl, incomingDestinationUrl)
  ) {
    const count = locks.destination.mirroredCount;
    return {
      ok: false,
      lock: "destination",
      message:
        `The destination is locked: ${count} ${count === 1 ? "repository is" : "repositories are"} mirrored to ` +
        `${normalizeDestinationUrl(existingDestinationUrl)}. ` +
        `Confirm the change to switch to ${normalizeDestinationUrl(incomingDestinationUrl)}.`,
    };
  }

  return { ok: true };
}

/**
 * Count the user's repositories to derive the locks. Any failure resolves
 * to "unlocked" with a warning: a broken count must not block the
 * Configuration page, and the mirror step still refuses cross-host tokens.
 */
export async function loadConfigLocks(userId: string): Promise<ConfigLockState> {
  try {
    const { db, repositories } = await import("@/lib/db");
    const { and, eq, sql } = await import("drizzle-orm");

    const [all] = await db
      .select({ count: sql<number>`count(*)` })
      .from(repositories)
      .where(eq(repositories.userId, userId));

    const statusList = MIRRORED_STATUSES.map((status) => `'${status}'`).join(", ");
    const [mirrored] = await db
      .select({ count: sql<number>`count(*)` })
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, userId),
          sql`(${repositories.status} in (${sql.raw(statusList)}) or coalesce(${repositories.mirroredLocation}, '') <> '')`
        )
      );

    return computeConfigLocks({
      repositoryCount: Number(all?.count ?? 0),
      mirroredCount: Number(mirrored?.count ?? 0),
    });
  } catch (error) {
    console.warn(
      `[Config] Could not compute source/destination locks for user ${userId}; treating as unlocked: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return UNLOCKED_CONFIG;
  }
}
