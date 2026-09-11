import { v4 as uuidv4 } from 'uuid';
import type { GitRepo } from '@/types/Repository';
import { repositories } from '@/lib/db/schema';
import { getRepositorySource } from '@/lib/source-providers/kinds';
import type { RepositoryDestination } from '@/lib/destination-kinds';

export type RepoInsert = typeof repositories.$inferInsert;

// Merge lists and de-duplicate by fullName, preferring starred variant when present
export function mergeGitReposPreferStarred(
  basicAndForked: GitRepo[],
  starred: GitRepo[]
): GitRepo[] {
  const map = new Map<string, GitRepo>();
  for (const r of [...basicAndForked, ...starred]) {
    const existing = map.get(r.fullName);
    if (!existing || (!existing.isStarred && r.isStarred)) {
      map.set(r.fullName, r);
    }
  }
  return Array.from(map.values());
}

// Convert a GitRepo to a normalized DB insert object with all nullable fields set
export function normalizeGitRepoToInsert(
  repo: GitRepo,
  {
    userId,
    configId,
    sourceId = null,
  }: { userId: string; configId: string; sourceId?: string | null }
): RepoInsert {
  return {
    id: uuidv4(),
    userId,
    configId,
    sourceId,
    name: repo.name,
    fullName: repo.fullName,
    normalizedFullName: repo.fullName.toLowerCase(),
    url: repo.url,
    cloneUrl: repo.cloneUrl,
    owner: repo.owner,
    organization: repo.organization ?? null,
    mirroredLocation: repo.mirroredLocation || '',
    ...repositorySourceColumns(repo),
    destinationOrg: repo.destinationOrg || null,
    isPrivate: repo.isPrivate,
    isForked: repo.isForked,
    forkedFrom: repo.forkedFrom ?? null,
    hasIssues: repo.hasIssues,
    isStarred: repo.isStarred,
    isArchived: repo.isArchived,
    size: repo.size,
    hasLFS: repo.hasLFS,
    hasSubmodules: repo.hasSubmodules,
    language: repo.language ?? null,
    description: repo.description ?? null,
    defaultBranch: repo.defaultBranch,
    visibility: repo.visibility,
    status: 'imported',
    lastMirrored: repo.lastMirrored ?? null,
    errorMessage: repo.errorMessage ?? null,
    importedAt: repo.importedAt || new Date(),
    createdAt: repo.createdAt || new Date(),
    updatedAt: repo.updatedAt || new Date(),
  };
}

// The source columns for an insert, defaulting to GitHub for legacy producers
export function repositorySourceColumns(
  repo: Pick<GitRepo, 'sourceProvider' | 'sourceUrl'>
): Pick<RepoInsert, 'sourceProvider' | 'sourceUrl'> {
  const source = getRepositorySource(repo);
  return { sourceProvider: source.provider, sourceUrl: source.url };
}

// Compute a safe batch size based on SQLite 999-parameter limit
export function calcBatchSizeForInsert(columnCount: number, maxParams = 999): number {
  if (columnCount <= 0) return 1;
  // Reserve a little headroom in case column count drifts
  const safety = 0;
  const effectiveMax = Math.max(1, maxParams - safety);
  return Math.max(1, Math.floor(effectiveMax / columnCount));
}

/**
 * The destination columns for a new repository row: where its mirror will
 * live, taken from the destination that is configured now.
 */
export function repositoryDestinationColumns(
  destination: RepositoryDestination
): Pick<RepoInsert, 'destinationProvider' | 'destinationUrl'> {
  return { destinationProvider: destination.provider, destinationUrl: destination.url };
}

/**
 * Upstream identity of a repository row: which host it lives on and its full
 * name there. The repositories table is unique on (userId, sourceId,
 * normalizedFullName) so that the same owner/name can be tracked on two
 * hosts, but two source rows can point at the same host (a personal token
 * source and a public-only source, both github.com), and a legacy row with a
 * NULL sourceId is distinct from a re-imported one. Discovery used the unique
 * index alone to decide what was new, so one upstream repository could end up
 * as two rows that both mirror to the same destination repository and get
 * processed together in one batch (one of the overlaps behind #417).
 */
export interface RepositoryIdentityFields {
  sourceProvider?: string | null;
  sourceUrl?: string | null;
  normalizedFullName: string;
}

export function repositoryIdentityKey(row: RepositoryIdentityFields): string {
  const provider = (row.sourceProvider || 'github').trim().toLowerCase();
  const url = (row.sourceUrl || 'https://github.com').trim().toLowerCase().replace(/\/+$/, '');
  return `${provider}|${url}|${row.normalizedFullName.toLowerCase()}`;
}

/**
 * Split discovered rows into the ones not yet tracked for this user on the
 * same host under any source, and the ones that are. Also drops repeats
 * within `candidates` themselves. `existing` is extended with every fresh
 * row, so a caller looping over several sources can pass the same set.
 */
export function selectNewRepositoriesByIdentity<T extends RepositoryIdentityFields>(
  candidates: T[],
  existing: Set<string>
): { fresh: T[]; alreadyTracked: T[] } {
  const fresh: T[] = [];
  const alreadyTracked: T[] = [];
  for (const candidate of candidates) {
    const key = repositoryIdentityKey(candidate);
    if (existing.has(key)) {
      alreadyTracked.push(candidate);
    } else {
      existing.add(key);
      fresh.push(candidate);
    }
  }
  return { fresh, alreadyTracked };
}

export function repositoryIdentityKeys(rows: Iterable<RepositoryIdentityFields>): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) keys.add(repositoryIdentityKey(row));
  return keys;
}

/**
 * Keep one row per upstream identity in a processing batch, so two rows that
 * resolve to the same destination repository are never mirrored or synced in
 * the same pass. A row linked to a source wins over a legacy row without one;
 * otherwise the first row in the batch is kept.
 */
export function dedupeRepositoriesByIdentity<
  T extends RepositoryIdentityFields & { sourceId?: string | null },
>(rows: T[]): { kept: T[]; dropped: T[] } {
  const byKey = new Map<string, T>();
  const dropped: T[] = [];
  for (const row of rows) {
    const key = repositoryIdentityKey(row);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, row);
    } else if (!current.sourceId && row.sourceId) {
      dropped.push(current);
      byKey.set(key, row);
    } else {
      dropped.push(row);
    }
  }
  return { kept: Array.from(byKey.values()), dropped };
}
