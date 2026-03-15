import { describe, it, expect } from 'bun:test';
import { mergeGitReposPreferStarred, normalizeGitRepoToInsert, calcBatchSizeForInsert } from '@/lib/repo-utils';
import type { GitRepo } from '@/types/Repository';

function sampleRepo(overrides: Partial<GitRepo> = {}): GitRepo {
  const base: GitRepo = {
    name: 'repo',
    fullName: 'owner/repo',
    url: 'https://github.com/owner/repo',
    cloneUrl: 'https://github.com/owner/repo.git',
    owner: 'owner',
    organization: undefined,
    mirroredLocation: '',
    destinationOrg: null,
    isPrivate: false,
    isForked: false,
    forkedFrom: undefined,
    hasIssues: true,
    isStarred: false,
    isArchived: false,
    size: 1,
    hasLFS: false,
    hasSubmodules: false,
    language: null,
    description: null,
    defaultBranch: 'main',
    visibility: 'public',
    status: 'imported',
    lastMirrored: undefined,
    errorMessage: undefined,
    importedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides };
}

describe('mergeGitReposPreferStarred', () => {
  it('keeps unique repos', () => {
    const basic = [sampleRepo({ fullName: 'a/x', name: 'x' })];
    const starred: GitRepo[] = [];
    const merged = mergeGitReposPreferStarred(basic, starred);
    expect(merged).toHaveLength(1);
    expect(merged[0].fullName).toBe('a/x');
  });

  it('prefers starred when duplicate exists', () => {
    const basic = [sampleRepo({ fullName: 'a/x', name: 'x', isStarred: false })];
    const starred = [sampleRepo({ fullName: 'a/x', name: 'x', isStarred: true })];
    const merged = mergeGitReposPreferStarred(basic, starred);
    expect(merged).toHaveLength(1);
    expect(merged[0].isStarred).toBe(true);
  });
});

describe('normalizeGitRepoToInsert', () => {
  it('sets undefined optional fields to null', () => {
    const repo = sampleRepo({ organization: undefined, forkedFrom: undefined, language: undefined, description: undefined, lastMirrored: undefined, errorMessage: undefined });
    const insert = normalizeGitRepoToInsert(repo, { userId: 'u', configId: 'c' });
    expect(insert.organization).toBeNull();
    expect(insert.forkedFrom).toBeNull();
    expect(insert.language).toBeNull();
    expect(insert.description).toBeNull();
    expect(insert.lastMirrored).toBeNull();
    expect(insert.errorMessage).toBeNull();
    expect(insert.normalizedFullName).toBe(repo.fullName.toLowerCase());
  });
});

describe('calcBatchSizeForInsert', () => {
  it('respects 999 parameter limit', () => {
    const batch = calcBatchSizeForInsert(29);
    expect(batch).toBeGreaterThan(0);
    expect(batch * 29).toBeLessThanOrEqual(999);
  });
});
