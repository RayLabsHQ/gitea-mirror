import { v4 as uuidv4 } from 'uuid';
import type { GitRepo } from '@/types/Repository';
import { repositories } from '@/lib/db/schema';

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
  }: { userId: string; configId: string }
): RepoInsert {
  return {
    id: uuidv4(),
    userId,
    configId,
    name: repo.name,
    fullName: repo.fullName,
    normalizedFullName: repo.fullName.toLowerCase(),
    url: repo.url,
    cloneUrl: repo.cloneUrl,
    owner: repo.owner,
    organization: repo.organization ?? null,
    mirroredLocation: repo.mirroredLocation || '',
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

// Compute a safe batch size based on SQLite 999-parameter limit
export function calcBatchSizeForInsert(columnCount: number, maxParams = 999): number {
  if (columnCount <= 0) return 1;
  // Reserve a little headroom in case column count drifts
  const safety = 0;
  const effectiveMax = Math.max(1, maxParams - safety);
  return Math.max(1, Math.floor(effectiveMax / columnCount));
}
