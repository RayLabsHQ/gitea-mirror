/**
 * Organization repository discovery.
 *
 * An organization pinned to a source can gain newly published upstream
 * repositories at any time, and a public-only (tokenless) source never runs
 * the personal listings that would otherwise surface them. The scheduler
 * re-lists every included organization on each tick and the manual
 * organization sync re-lists a single one, so both go through the function
 * below and the identity rules (what already counts as tracked) live in one
 * place.
 *
 * Repositories missing from the listing are deliberately NOT removed: a
 * tokenless listing only shows public repositories, so cleanup stays
 * membership-based (repository-cleanup-service).
 */

import { eq } from 'drizzle-orm';
import { db, organizations, repositories } from '@/lib/db';
import type { Config } from '@/lib/db/schema';
import {
  calcBatchSizeForInsert,
  normalizeGitRepoToInsert,
  repositoryIdentityKeys,
  selectNewRepositoriesByIdentity,
} from '@/lib/repo-utils';
import { resolveOrganizationSkipForks } from '@/lib/utils/mirror-overrides';
import type { SourceRecord } from '@/lib/sources';

/** The organization fields re-discovery reads. */
export interface DiscoverableOrganization {
  id: string;
  name: string;
  sourceId?: string | null;
  status?: string | null;
  isIncluded?: boolean | null;
  mirrorOverrides?: unknown;
}

export interface OrganizationRediscoveryResult {
  /**
   * False when nothing ran: the organization is ignored or excluded, or its
   * pin resolves to no enabled source.
   */
  ran: boolean;
  /** Repositories the source listed for the organization. */
  listed: number;
  /** New repository rows inserted by this pass. */
  imported: number;
  /** Listed repositories that another row already tracks on the same host. */
  alreadyTracked: number;
}

const NOTHING_DISCOVERED: OrganizationRediscoveryResult = {
  ran: false,
  listed: 0,
  imported: 0,
  alreadyTracked: 0,
};

/**
 * Re-list one organization on the source it is pinned to and insert the
 * repositories that are not tracked yet (onConflictDoNothing keeps repeats
 * idempotent). Unpinned organizations and pins whose source is gone keep the
 * legacy DB-only behavior, so nothing changes for them.
 */
export async function rediscoverRepositoriesForOrganization({
  config,
  userId,
  organization,
  sources,
  existingRepoKeys,
  phase,
  logPrefix = '[Scheduler]',
}: {
  config: Partial<Config> & { id: string };
  userId: string;
  organization: DiscoverableOrganization;
  /** Enabled sources, when the caller already loaded them. */
  sources?: SourceRecord[];
  /**
   * Identity keys of the repositories already tracked, when the caller
   * already built them. Claimed keys are added to the set, so a caller that
   * loops over organizations passes one set and never inserts the same
   * upstream repository twice.
   */
  existingRepoKeys?: Set<string>;
  /** Named in the log lines, e.g. "scheduled sync". */
  phase: string;
  logPrefix?: string;
}): Promise<OrganizationRediscoveryResult> {
  // An ignored organization is left alone entirely: rediscovering it would
  // insert its new repositories as imported and auto-mirror could pick them
  // up, which is what the user just asked to stop (#429).
  if (organization.status === 'ignored' || organization.isIncluded === false) {
    return NOTHING_DISCOVERED;
  }

  const { listSources, findSourceForOrganization } = await import('@/lib/sources');
  const { createSourceProviderFromSource } = await import('@/lib/source-providers');

  const sourceList = sources ?? (await listSources(userId)).filter(source => source.enabled);
  const source = findSourceForOrganization(organization, sourceList);
  if (!source) return NOTHING_DISCOVERED;

  // Same identity rule as personal discovery: an organization pinned to a
  // public-only source must not re-insert repositories the personal source
  // already tracks on the same host (or the other way round).
  const knownKeys = existingRepoKeys ?? repositoryIdentityKeys(
    await db
      .select({
        normalizedFullName: repositories.normalizedFullName,
        sourceProvider: repositories.sourceProvider,
        sourceUrl: repositories.sourceUrl,
      })
      .from(repositories)
      .where(eq(repositories.userId, userId))
  );

  const sourceProvider = createSourceProviderFromSource(source, { userId });
  const orgRepos = await sourceProvider.listOrganizationRepositories(organization.name);

  // The organization's fork policy (override -> global skipForks), the same
  // resolution the organization mirror path applies.
  const skipOrgForks = resolveOrganizationSkipForks({
    orgOverrides: organization.mirrorOverrides,
    config,
  });
  const mirrorableRepos = orgRepos.filter(
    repo => repo.isDisabled !== true && !(skipOrgForks && repo.isForked)
  );

  const { fresh: repoRecords, alreadyTracked } = selectNewRepositoriesByIdentity(
    mirrorableRepos.map(repo =>
      normalizeGitRepoToInsert(
        { ...repo, organization: repo.organization ?? organization.name },
        { userId, configId: config.id, sourceId: source.id }
      )
    ),
    knownKeys
  );

  if (repoRecords.length > 0) {
    // Batch insert to avoid SQLite parameter limit
    const sample = repoRecords[0];
    const columnCount = Object.keys(sample ?? {}).length || 1;
    const BATCH_SIZE = calcBatchSizeForInsert(columnCount);
    for (let i = 0; i < repoRecords.length; i += BATCH_SIZE) {
      const batch = repoRecords.slice(i, i + BATCH_SIZE);
      await db
        .insert(repositories)
        .values(batch)
        .onConflictDoNothing({ target: [repositories.userId, repositories.sourceId, repositories.normalizedFullName] });
    }
    console.log(`${logPrefix} Re-discovered ${repoRecords.length} new repositories for organization ${organization.name} on source ${source.name} for user ${userId} during ${phase}`);
  }
  if (alreadyTracked.length > 0) {
    console.log(`${logPrefix} Organization ${organization.name}: ${alreadyTracked.length} repositories are already tracked for user ${userId} on the same host, not adding them again under source ${source.name}`);
  }

  await db
    .update(organizations)
    .set({ repositoryCount: orgRepos.length, updatedAt: new Date() })
    .where(eq(organizations.id, organization.id));

  return {
    ran: true,
    listed: orgRepos.length,
    imported: repoRecords.length,
    alreadyTracked: alreadyTracked.length,
  };
}
