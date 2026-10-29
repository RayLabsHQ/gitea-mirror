/**
 * Refresh sizes: measure every mirror on the destination now instead of
 * waiting for each one's next sync (#479 follow-up). It only reads the
 * destination and never contacts the source:
 *
 * - one listing per destination owner carries every repository's `size`;
 * - a repository missing from its owner's listing gets the single GET, which
 *   follows a rename or transfer the way a sync does;
 * - repositories that mirror releases get their release listing read.
 *
 * Runs in the background, one run per user at a time. Progress lives in memory
 * and the storage overview reports it.
 */

import { eq, sql } from "drizzle-orm";
import { db, configs, repositories } from "./db";
import type { Repository } from "./db/schema";
import type { Config } from "@/types/config";
import { HttpError, httpGet } from "./http-client";
import { decryptConfigTokens } from "./utils/config-encryption";
import { isPushDestinationKind, normalizeDestinationProviderKind } from "./destination-kinds";
import { getGiteaRepoOwnerAsync } from "./gitea";
import { resolveMirrorOptionsForRepository } from "./utils/mirror-overrides";
import { listDestinationOwnerRepositories, listDestinationReleases } from "./destination-listing";
import { countsAsStorageMirror, destinationSizeColumns, summarizeReleaseAssets } from "./repository-storage";
import { processInParallel } from "./utils/concurrency";

// Requests in flight against the destination at once.
const CONCURRENCY = 4;

export interface StorageRefreshProgress {
  running: boolean;
  /** Repositories this run measures. */
  total: number;
  /** Repositories finished, whatever the outcome. */
  done: number;
  measured: number;
  /** Not found on the destination where the mirror should be. */
  missing: number;
  /** A request failed; the stored numbers were kept. */
  failed: number;
  startedAt: string;
  finishedAt: string | null;
}

/** The destination's answer for one repository, the fields used here. */
interface DestinationRepository {
  name?: string;
  owner?: { login?: string } | string;
  mirror?: boolean;
  size?: number;
}

interface Target {
  repository: Repository;
  owner: string;
  name: string;
  /** False when the location was not recorded and is only where a sync would look. */
  recorded: boolean;
}

const runs = new Map<string, StorageRefreshProgress>();
const inFlight = new Map<string, Promise<void>>();

export function getStorageRefreshProgress(userId: string): StorageRefreshProgress | null {
  const run = runs.get(userId);
  return run ? { ...run } : null;
}

/** Resolves when the user's current run ends. For tests. */
export function waitForStorageRefresh(userId: string): Promise<void> {
  return inFlight.get(userId) ?? Promise.resolve();
}

export type StartStorageRefreshResult =
  | { ok: true; progress: StorageRefreshProgress }
  | { ok: false; status: number; error: string };

/** Start a run for the user, or report the one already running. */
export async function startStorageRefresh(userId: string): Promise<StartStorageRefreshResult> {
  const previous = runs.get(userId);
  if (previous?.running) return { ok: true, progress: { ...previous } };

  // Claimed before the first await so a second click cannot start a twin.
  const progress: StorageRefreshProgress = {
    running: true,
    total: 0,
    done: 0,
    measured: 0,
    missing: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  runs.set(userId, progress);

  const release = () => {
    if (previous) runs.set(userId, previous);
    else runs.delete(userId);
  };
  const refuse = (status: number, error: string): StartStorageRefreshResult => {
    release();
    return { ok: false, status, error };
  };

  let config: Partial<Config>;
  let targets: Repository[];
  try {
    const [configRow] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);
    if (!configRow?.giteaConfig?.url || !configRow.giteaConfig.token) {
      return refuse(400, "Configure the destination URL and token first");
    }
    if (isPushDestinationKind(normalizeDestinationProviderKind(configRow.giteaConfig.provider))) {
      return refuse(400, "Sizes are read from Gitea and Forgejo destinations only");
    }
    config = configRow as unknown as Partial<Config>;

    const rows = await db.select().from(repositories).where(eq(repositories.userId, userId));
    targets = (rows as Repository[]).filter((row) =>
      countsAsStorageMirror({
        status: row.status,
        destinationProvider: row.destinationProvider ?? "gitea",
        destinationSize: row.destinationSize ?? null,
        releaseAssetsSize: row.releaseAssetsSize ?? null,
      })
    );
  } catch (error) {
    release();
    throw error;
  }

  progress.total = targets.length;
  const run = measureAll(config, targets, progress)
    .catch((error) => {
      console.error(
        `[Storage] Refresh sizes stopped for user ${userId}: ${error instanceof Error ? error.message : String(error)}`
      );
    })
    .finally(() => {
      progress.failed += progress.total - progress.done;
      progress.done = progress.total;
      progress.running = false;
      progress.finishedAt = new Date().toISOString();
      inFlight.delete(userId);
      console.log(
        `[Storage] Refreshed sizes for user ${userId}: ${progress.measured} measured, ${progress.missing} not found, ${progress.failed} failed`
      );
    });
  inFlight.set(userId, run);

  return { ok: true, progress: { ...progress } };
}

function parseLocation(location: string | null | undefined): { owner: string; name: string } | null {
  const trimmed = (location ?? "").trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

async function measureAll(
  config: Partial<Config>,
  rows: Repository[],
  progress: StorageRefreshProgress
): Promise<void> {
  const baseUrl = config.giteaConfig!.url.replace(/\/+$/, "");
  const token = decryptConfigTokens(config as Config).giteaConfig.token;

  // Where each mirror is, or where a sync would look for it.
  const targets: Target[] = [];
  for (const repository of rows) {
    const recorded = parseLocation(repository.mirroredLocation);
    if (recorded) {
      targets.push({ repository, ...recorded, recorded: true });
      continue;
    }
    const owner = await getGiteaRepoOwnerAsync({ config, repository }).catch(() => "");
    if (owner) {
      targets.push({ repository, owner, name: repository.name, recorded: false });
    } else {
      progress.failed += 1;
      progress.done += 1;
    }
  }

  // One listing per owner. A failed listing leaves its repositories to the
  // single GET below.
  const owners = [...new Map(targets.map((t) => [t.owner.toLowerCase(), t.owner])).values()];
  const listings = new Map<string, Map<string, DestinationRepository>>();
  await processInParallel(
    owners,
    async (owner) => {
      const listing = await listDestinationOwnerRepositories<DestinationRepository>({ baseUrl, token, owner });
      if (!listing.complete) return;
      const byName = new Map<string, DestinationRepository>();
      for (const repo of listing.items) {
        if (typeof repo?.name === "string") byName.set(repo.name.toLowerCase(), repo);
      }
      listings.set(owner.toLowerCase(), byName);
    },
    CONCURRENCY
  );

  await processInParallel(
    targets,
    async (target) => {
      try {
        const outcome = await measureOne({ config, baseUrl, token, target, listings });
        progress[outcome] += 1;
      } catch (error) {
        progress.failed += 1;
        console.warn(
          `[Storage] Could not measure ${target.owner}/${target.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        progress.done += 1;
      }
    },
    CONCURRENCY
  );
}

async function measureOne({
  config,
  baseUrl,
  token,
  target,
  listings,
}: {
  config: Partial<Config>;
  baseUrl: string;
  token: string;
  target: Target;
  listings: Map<string, Map<string, DestinationRepository>>;
}): Promise<"measured" | "missing" | "failed"> {
  let info = listings.get(target.owner.toLowerCase())?.get(target.name.toLowerCase()) ?? null;
  if (!info) {
    try {
      const response = await httpGet<DestinationRepository>(
        `${baseUrl}/api/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`,
        { Authorization: `token ${token}` }
      );
      info = response.data;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return "missing";
      throw error;
    }
  }
  // Without a recorded location, only a mirror at the expected place is ours.
  if (!info || (!target.recorded && info.mirror !== true)) return "missing";

  const now = new Date();
  const columns: Partial<
    Pick<Repository, "destinationSize" | "releaseAssetsSize" | "releaseAssetsCount" | "storageCheckedAt">
  > = { ...destinationSizeColumns(info, now) };

  const { mirrorReleases } = await resolveMirrorOptionsForRepository({ config, repository: target.repository });
  if (mirrorReleases) {
    const owner = (typeof info.owner === "string" ? info.owner : info.owner?.login) || target.owner;
    const releases = await listDestinationReleases<{ assets?: Array<{ size?: unknown }> | null }>({
      baseUrl,
      token,
      owner,
      repo: info.name || target.name,
    });
    if (releases.complete) {
      const summary = summarizeReleaseAssets(releases.items);
      columns.releaseAssetsSize = summary.bytes;
      columns.releaseAssetsCount = summary.count;
      columns.storageCheckedAt = now;
    }
  }

  if (Object.keys(columns).length === 0) return "failed";
  await db.update(repositories).set(columns).where(eq(repositories.id, target.repository.id!));
  return "measured";
}
