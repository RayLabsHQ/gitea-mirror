/**
 * Reconcile the destination (Gitea or Forgejo) with the repositories table.
 *
 * Lists what the destination holds under every owner this account mirrors
 * into, sorts it against the database (see destination-reconcile.ts), and
 * on request adopts untracked mirrors, records where moved mirrors went, or
 * resets rows whose mirror is gone. It never deletes or archives anything on
 * either side; the cleanup service keeps its own rules for that.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db, organizations, repositories } from "@/lib/db";
import type { Repository } from "@/lib/db/schema";
import type { Config } from "@/types/config";
import type { GitRepo } from "@/types/Repository";
import { HttpError, httpGet } from "@/lib/http-client";
import { getDecryptedGiteaToken } from "@/lib/utils/config-encryption";
import { createSourceProviderFromConfig, resolveSourceConnection } from "@/lib/source-providers";
import { githubApiBaseUrl } from "@/lib/source-providers/github-source";
import { getGiteaRepoOwnerAsync } from "@/lib/gitea";
import { resolveDestinationIdentity } from "@/lib/destination-connection";
import { normalizeGitRepoToInsert } from "@/lib/repo-utils";
import { createMirrorJob } from "@/lib/helpers";
import { processInParallel } from "@/lib/utils/concurrency";
import {
  classifyDestinationRepos,
  collectDestinationOwners,
  expectedLocation,
  knownSourceHosts,
  parseRepoUrl,
  type DestinationRepo,
  splitRowsByDestination,
} from "@/lib/destination-reconcile";

const PAGE_SIZE = 50;
const MAX_PAGES = 400;
const LOOKUP_CONCURRENCY = 4;

export interface ReconcileOptions {
  dryRun: boolean;
  adoptUntracked: boolean;
  resetMissing: boolean;
  /** Repoint rows whose mirror was transferred to another owner (issue #400). */
  relocateMoved?: boolean;
}

export interface ReconcileReport {
  /** Mirrors of the configured source that have no database row. */
  untracked: Array<{
    location: string;
    originalUrl: string;
    sourcePath: string;
    isPrivate: boolean;
  }>;
  /** Rows that say mirrored, whose repository the destination no longer has. */
  missing: Array<{ id: string; fullName: string; location: string }>;
  /** Rows whose recorded mirror is gone while their source is mirrored under another owner. */
  moved: Array<{ id: string; fullName: string; from: string; to: string }>;
  /** Repositories on the destination this app does not own. */
  notManaged: Array<{ location: string; reason: string }>;
  /** Rows whose presence could not be confirmed because the check itself failed. */
  unverified: Array<{ fullName: string; location: string; error: string }>;
  healthyCount: number;
  /** Rows mirrored to another destination host; they are expected to be absent here. */
  elsewhereCount: number;
  scannedOwners: string[];
  skippedOwners: string[];
  totalOnDestination: number;
}

export interface ReconcileResult {
  dryRun: boolean;
  report: ReconcileReport;
  /** Null on a dry run. */
  applied: { adopted: number; reset: number; relocated: number; skipped: number } | null;
}

/** The subset of Gitea's repository JSON the reconcile reads. */
interface GiteaRepoJson {
  name?: string;
  full_name?: string;
  owner?: { login?: string; username?: string };
  mirror?: boolean;
  original_url?: string;
  private?: boolean;
  archived?: boolean;
  description?: string | null;
  default_branch?: string;
  size?: number;
  html_url?: string;
  clone_url?: string;
  language?: string | null;
  has_issues?: boolean;
  updated_at?: string;
  mirror_updated?: string;
}

function toDestinationRepo(json: GiteaRepoJson): DestinationRepo | null {
  const owner = json.owner?.login ?? json.owner?.username ?? json.full_name?.split("/")[0];
  const name = json.name ?? json.full_name?.split("/")[1];
  if (!owner || !name) return null;
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    mirror: json.mirror === true,
    originalUrl: json.original_url ?? "",
    isPrivate: json.private === true,
    isArchived: json.archived === true,
    description: json.description ?? null,
    defaultBranch: json.default_branch || "main",
    size: typeof json.size === "number" ? json.size : 0,
    htmlUrl: json.html_url ?? "",
    cloneUrl: json.clone_url ?? "",
    language: json.language ?? null,
    hasIssues: json.has_issues === true,
    updatedAt: json.updated_at ?? null,
    mirrorUpdated: json.mirror_updated ?? null,
  };
}

/**
 * Page through every repository an owner has on the destination. Tries the
 * organization listing first, then the user listing. Null when the owner
 * does not exist there.
 */
async function listDestinationOwnerRepos(
  baseUrl: string,
  headers: Record<string, string>,
  owner: string
): Promise<DestinationRepo[] | null> {
  for (const kind of ["orgs", "users"] as const) {
    const repos: DestinationRepo[] = [];
    let page = 1;
    let found = true;
    while (page <= MAX_PAGES) {
      let data: GiteaRepoJson[];
      try {
        const response = await httpGet<GiteaRepoJson[]>(
          `${baseUrl}/api/v1/${kind}/${encodeURIComponent(owner)}/repos?page=${page}&limit=${PAGE_SIZE}`,
          headers
        );
        data = Array.isArray(response.data) ? response.data : [];
      } catch (error) {
        if (error instanceof HttpError && error.status === 404 && page === 1) {
          found = false;
          break;
        }
        throw error;
      }
      for (const json of data) {
        const repo = toDestinationRepo(json);
        if (repo) repos.push(repo);
      }
      if (data.length < PAGE_SIZE) break;
      page += 1;
    }
    if (found) return repos;
  }
  return null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Web URL of the source repository, keeping the scheme the mirror was created with. */
function sourceWebUrl(originalUrl: string, path: string, fallbackHost: string): string {
  try {
    const url = new URL(originalUrl);
    return `${url.protocol}//${url.host}/${path}`;
  } catch {
    return `https://${fallbackHost}/${path}`;
  }
}

export async function reconcileDestination(
  config: Config,
  options: ReconcileOptions
): Promise<ReconcileResult> {
  const userId = config.userId;
  const giteaConfig = config.giteaConfig;
  const githubConfig = config.githubConfig;
  if (!userId || !config.id) {
    throw new Error("A saved configuration is required.");
  }
  if (!giteaConfig?.url || !giteaConfig?.token || !giteaConfig?.defaultOwner) {
    throw new Error("The destination URL, token and username must be configured first.");
  }

  const baseUrl = giteaConfig.url.replace(/\/+$/, "");
  const headers = { Authorization: `token ${getDecryptedGiteaToken(config)}` };
  const connection = resolveSourceConnection(config);
  const starredMode = githubConfig?.starredReposMode || "dedicated-org";
  const starredOrg = githubConfig?.starredReposOrg || "starred";
  const strategy =
    githubConfig?.mirrorStrategy || (giteaConfig.preserveOrgStructure ? "preserve" : "flat-user");

  const rows = await db.select().from(repositories).where(eq(repositories.userId, userId));
  const orgRows = await db
    .select({ name: organizations.name, destinationOrg: organizations.destinationOrg })
    .from(organizations)
    .where(eq(organizations.userId, userId));

  // Every owner the strategy or the database could have put a mirror under.
  const owners = collectDestinationOwners([
    giteaConfig.defaultOwner,
    giteaConfig.organization,
    starredMode === "preserve-owner" ? null : starredOrg,
    ...orgRows.flatMap((org) => [org.name, org.destinationOrg]),
    ...rows.flatMap((row) => [
      row.destinationOrg,
      (row.mirroredLocation ?? "").split("/")[0],
      row.organization,
      strategy === "preserve" ? row.owner : null,
    ]),
  ]);

  const scannedOwners: string[] = [];
  const skippedOwners: string[] = [];
  const destinationRepos: DestinationRepo[] = [];
  for (const owner of owners) {
    const repos = await listDestinationOwnerRepos(baseUrl, headers, owner);
    if (repos === null) {
      skippedOwners.push(owner);
      continue;
    }
    scannedOwners.push(owner);
    destinationRepos.push(...repos);
  }

  const knownHosts = knownSourceHosts({
    sourceUrl: connection.url,
    apiUrl: connection.provider === "github" ? githubApiBaseUrl() : null,
    cloneUrls: rows.map((row) => row.cloneUrl),
  });

  // Rows mirrored to a previous destination are neither healthy nor missing
  // here; they are left out of the comparison and only counted.
  const { here: rowsHere, elsewhere } = splitRowsByDestination(rows, resolveDestinationIdentity(config));
  const classified = classifyDestinationRepos({ destinationRepos, rows: rowsHere, knownHosts });
  const listedLocations = new Set(destinationRepos.map((repo) => repo.fullName.toLowerCase()));

  // Rows that claim a mirror the listing did not show. Confirm each one
  // directly before calling it missing, so a listing hiccup never resets a
  // healthy repository.
  const missing: ReconcileReport["missing"] = [];
  const unverified: ReconcileReport["unverified"] = [];
  let confirmedPresent = 0;
  await processInParallel(
    classified.unmatchedMirroredRows,
    async (row) => {
      let resolvedOwner = giteaConfig.defaultOwner;
      try {
        resolvedOwner = await getGiteaRepoOwnerAsync({
          config,
          repository: row as unknown as Repository,
        });
      } catch {
        // Fall back to the account; the direct check below decides.
      }
      const target = expectedLocation(row, resolvedOwner);
      if (listedLocations.has(target.location.toLowerCase())) {
        confirmedPresent += 1;
        return;
      }
      try {
        await httpGet(
          `${baseUrl}/api/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`,
          headers
        );
        confirmedPresent += 1;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          missing.push({ id: row.id, fullName: row.fullName, location: target.location });
        } else {
          unverified.push({
            fullName: row.fullName,
            location: target.location,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    LOOKUP_CONCURRENCY
  );

  const report: ReconcileReport = {
    untracked: classified.untracked.map((repo) => ({
      location: repo.fullName,
      originalUrl: repo.originalUrl,
      sourcePath: parseRepoUrl(repo.originalUrl)?.path ?? repo.originalUrl,
      isPrivate: repo.isPrivate,
    })),
    missing,
    moved: classified.moved.map((entry) => ({
      id: entry.row.id,
      fullName: entry.row.fullName,
      from: entry.row.mirroredLocation ?? "",
      to: entry.location,
    })),
    notManaged: classified.notManaged,
    unverified,
    // Moved rows are present but recorded wrong; they are listed on their own.
    healthyCount: classified.matchedRowIds.size - classified.moved.length + confirmedPresent,
    elsewhereCount: elsewhere.length,
    scannedOwners,
    skippedOwners,
    totalOnDestination: destinationRepos.length,
  };

  const relocateMoved = options.relocateMoved === true;
  if (options.dryRun || (!options.adoptUntracked && !options.resetMissing && !relocateMoved)) {
    return { dryRun: true, report, applied: null };
  }

  let adopted = 0;
  let skipped = 0;
  let reset = 0;
  let relocated = 0;

  if (options.adoptUntracked && classified.untracked.length > 0) {
    const sourceProvider = createSourceProviderFromConfig(config, { userId });
    await processInParallel(
      classified.untracked,
      async (repo) => {
        try {
          const outcome = await adoptUntrackedMirror({
            config,
            repo,
            lookup: (owner, name) => sourceProvider.getRepository(owner, name),
            connection,
            starredOrg: starredMode === "preserve-owner" ? null : starredOrg,
          });
          if (outcome === "adopted") adopted += 1;
          else skipped += 1;
        } catch (error) {
          skipped += 1;
          console.warn(
            `[Reconcile] Could not adopt ${repo.fullName}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
      LOOKUP_CONCURRENCY
    );
  }

  if (options.resetMissing && missing.length > 0) {
    const ids = missing.map((entry) => entry.id);
    const updated = await db
      .update(repositories)
      .set({
        status: "imported",
        mirroredLocation: "",
        errorMessage: "Not found on the destination during reconcile. The next mirror run recreates it.",
        updatedAt: new Date(),
      })
      .where(and(eq(repositories.userId, userId), inArray(repositories.id, ids)))
      .returning({ id: repositories.id });
    reset = updated.length;
  }

  if (relocateMoved && classified.moved.length > 0) {
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    for (const entry of classified.moved) {
      const row = rowsById.get(entry.row.id);
      if (!row) {
        skipped += 1;
        continue;
      }
      const newOwner = entry.location.split("/")[0];

      // Pin the row to its new owner when the strategy would resolve
      // elsewhere, as adoption does, so a later reset does not recreate the
      // mirror at the old place. The strategy already honours the row's own
      // override, so an override pointing at the old owner is replaced.
      let destinationOrg = row.destinationOrg ?? null;
      try {
        const strategyOwner = await getGiteaRepoOwnerAsync({ config, repository: row as Repository });
        if (strategyOwner.trim().toLowerCase() !== newOwner.toLowerCase()) {
          destinationOrg = newOwner;
        }
      } catch {
        destinationOrg = newOwner;
      }

      try {
        await db
          .update(repositories)
          .set({
            mirroredLocation: entry.location,
            destinationOrg,
            // A sync that failed because the mirror was not at the recorded
            // place is healthy again once the row points at it.
            ...(row.status === "failed" ? { status: "mirrored", errorMessage: null } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(repositories.userId, userId), eq(repositories.id, row.id)));
        relocated += 1;
      } catch (error) {
        skipped += 1;
        console.warn(
          `[Reconcile] Could not record the new location of ${row.fullName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  if (adopted > 0 || reset > 0 || relocated > 0) {
    await createMirrorJob({
      userId,
      status: "synced",
      jobType: "sync",
      message: "Reconciled the database with the destination",
      details: `Adopted ${adopted} untracked mirror${adopted === 1 ? "" : "s"}, recorded the new location of ${relocated} moved mirror${relocated === 1 ? "" : "s"}, reset ${reset} row${reset === 1 ? "" : "s"} whose mirror was gone.`,
      skipNotification: true,
    });
  }

  return { dryRun: false, report, applied: { adopted, reset, relocated, skipped } };
}

/**
 * Create the database row for a mirror the destination has and the
 * database does not. Prefers the source's own metadata, falls back to what
 * the destination reports when the source repository cannot be read.
 */
async function adoptUntrackedMirror({
  config,
  repo,
  lookup,
  connection,
  starredOrg,
}: {
  config: Config;
  repo: DestinationRepo;
  lookup: (owner: string, name: string) => Promise<GitRepo | null>;
  connection: { provider: GitRepo["sourceProvider"]; url: string };
  starredOrg: string | null;
}): Promise<"adopted" | "skipped"> {
  const origin = parseRepoUrl(repo.originalUrl);
  if (!origin) return "skipped";

  let fromSource: GitRepo | null = null;
  try {
    fromSource = await lookup(origin.owner, origin.name);
  } catch {
    fromSource = null;
  }

  const now = new Date();
  const lastMirrored = parseDate(repo.mirrorUpdated) ?? parseDate(repo.updatedAt) ?? now;
  const fallback: GitRepo = {
    name: origin.name,
    fullName: origin.path,
    url: sourceWebUrl(repo.originalUrl, origin.path, origin.host),
    cloneUrl: repo.originalUrl,
    owner: origin.owner,
    sourceProvider: connection.provider,
    sourceUrl: connection.url,
    isPrivate: repo.isPrivate,
    isForked: false,
    hasIssues: repo.hasIssues,
    isStarred: false,
    isArchived: repo.isArchived,
    size: repo.size,
    hasLFS: false,
    hasSubmodules: false,
    language: repo.language,
    description: repo.description,
    defaultBranch: repo.defaultBranch,
    visibility: repo.isPrivate ? "private" : "public",
    status: "mirrored",
    importedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const livesInStarredOrg =
    starredOrg !== null && repo.owner.trim().toLowerCase() === starredOrg.trim().toLowerCase();

  const gitRepo: GitRepo = {
    ...(fromSource ?? fallback),
    isStarred: livesInStarredOrg || fromSource?.isStarred === true,
    status: "mirrored",
    mirroredLocation: repo.fullName,
    lastMirrored,
    errorMessage: undefined,
    importedAt: now,
  };

  const insert = normalizeGitRepoToInsert(gitRepo, { userId: config.userId!, configId: config.id! });
  // The normalizer always starts rows as imported; this one is already mirrored.
  insert.status = "mirrored";
  insert.mirroredLocation = repo.fullName;
  insert.lastMirrored = lastMirrored;
  insert.errorMessage = null;

  // If the strategy would put this repository somewhere else, pin it where
  // it already is so the next sync does not create a second copy.
  try {
    const strategyOwner = await getGiteaRepoOwnerAsync({
      config,
      repository: insert as unknown as Repository,
    });
    if (strategyOwner.trim().toLowerCase() !== repo.owner.trim().toLowerCase()) {
      insert.destinationOrg = repo.owner;
    }
  } catch {
    insert.destinationOrg = repo.owner;
  }

  const inserted = await db
    .insert(repositories)
    .values(insert)
    .onConflictDoNothing({ target: [repositories.userId, repositories.normalizedFullName] })
    .returning({ id: repositories.id });

  return inserted.length > 0 ? "adopted" : "skipped";
}
