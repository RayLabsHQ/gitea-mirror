/**
 * Shared shaping for the /api/sources endpoints and the sources array the
 * configuration GET returns: source rows from the service layer joined with
 * per-source repository counts. Tokens are write-only: an item says whether
 * one is saved (hasToken) and never carries it.
 *
 * The database and service modules are imported lazily (the same pattern as
 * loadConfigLocks) so per-test-file module mocks keep working.
 */
import { eq, sql } from "drizzle-orm";
import type { SourceProviderKind } from "@/lib/source-providers/kinds";
import { isGitHubAppCredential, parseGitHubAppCredentials } from "@/lib/github-app-credentials";

/** One source as the API returns it: the stored row plus its lock state. */
export interface SourceApiItem {
  id: string;
  name: string;
  provider: SourceProviderKind;
  url: string;
  username: string;
  /** A token is saved. False for public-only sources and GitHub App sources. */
  hasToken: boolean;
  authType: "pat" | "app";
  appId?: string;
  installationId?: string;
  enabled: boolean;
  repositoryCount: number;
  locked: boolean;
}

/** The source fields the service layer hands back (the SourceRecord shape). */
export interface SourceRowLike {
  id: string;
  name: string;
  provider: SourceProviderKind;
  url: string | null;
  username: string;
  token: string | null;
  enabled: boolean;
}

export async function toSourceApiItem(
  source: SourceRowLike,
  repositoryCount: number
): Promise<SourceApiItem> {
  const { decryptSourceToken } = await import("@/lib/sources");
  const token = decryptSourceToken(source.token);
  // Only an App credential is read here, for its App and installation IDs.
  // Don't fail the whole listing over a damaged one.
  const appCredential = isGitHubAppCredential(token);
  let app: ReturnType<typeof parseGitHubAppCredentials> = null;
  if (appCredential && source.provider === "github") {
    try {
      app = parseGitHubAppCredentials(token);
    } catch {
      app = null;
    }
  }
  return {
    id: source.id,
    name: source.name,
    provider: source.provider,
    url: source.url ?? "",
    username: source.username,
    hasToken: !appCredential && token.trim().length > 0,
    authType: app ? "app" : "pat",
    appId: app?.appId,
    installationId: app?.installationId,
    enabled: source.enabled,
    repositoryCount,
    locked: repositoryCount > 0,
  };
}

/**
 * All of a user's sources with the number of repositories imported from
 * each. A source with repositories is locked (see config-locks).
 */
export async function loadSourceApiItems(userId: string): Promise<SourceApiItem[]> {
  const [{ listSources }, { db, repositories }] = await Promise.all([
    import("@/lib/sources"),
    import("@/lib/db"),
  ]);

  const sources = await listSources(userId);

  const countRows = await db
    .select({ sourceId: repositories.sourceId, count: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.userId, userId))
    .groupBy(repositories.sourceId);

  const counts = new Map<string, number>();
  for (const row of countRows) {
    if (row.sourceId) {
      counts.set(row.sourceId, Number(row.count));
    }
  }

  return Promise.all(
    sources.map((source) => toSourceApiItem(source, counts.get(source.id) ?? 0))
  );
}

/**
 * Whether the service refused a create because the user already has this
 * (provider, url, username) combination. Checked structurally so it works
 * with the service's typed duplicate error.
 */
export function isDuplicateSourceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, name, message } = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  if (typeof code === "string" && /duplicate/i.test(code)) return true;
  if (typeof name === "string" && /duplicate/i.test(name)) return true;
  return (
    typeof message === "string" && /already (connected|exists|added)/i.test(message)
  );
}
