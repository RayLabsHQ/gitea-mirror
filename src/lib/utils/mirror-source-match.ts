import type { Config } from "@/types/config";
import type { Repository } from "@/lib/db/schema";
import type { GiteaRepoInfo } from "@/lib/gitea-enhanced";

/**
 * Source-identity matching for mirror reuse.
 *
 * Starred (and other) repos were duplicating on every re-mirror because the
 * existence check only asked "does a repo with this name exist?" — never
 * "is the existing repo a mirror of THIS same GitHub source?". This module
 * answers the second question so callers can reuse an existing same-source
 * mirror instead of generating a suffixed duplicate. See issues #315 / #309.
 */

/**
 * Normalize a git clone URL for source-identity comparison.
 * Strips embedded credentials, a trailing ".git", a trailing slash, and
 * lowercases the host (hosts are case-insensitive; paths are not). Returns an
 * empty string for blank/invalid input so callers can treat it as "unknown".
 */
export function normalizeCloneUrl(rawUrl?: string | null): string {
  if (typeof rawUrl !== "string") return "";
  let url = rawUrl.trim();
  if (!url) return "";

  try {
    const parsed = new URL(url);
    // Drop any embedded credentials (e.g. https://user:token@host/...).
    parsed.username = "";
    parsed.password = "";
    const host = parsed.host.toLowerCase();
    // Strip trailing slash(es) first so a ".git/" suffix still normalizes.
    const path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return `${parsed.protocol}//${host}${path}`.toLowerCase();
  } catch {
    // Fall back to best-effort string normalization for non-standard URLs
    // (e.g. scp-style git@host:owner/repo). Strip credentials before "@",
    // drop ".git"/trailing slash, and lowercase the whole thing.
    url = url.replace(/^([a-z]+:\/\/)[^@/]+@/i, "$1");
    url = url.replace(/\/+$/, "").replace(/\.git$/i, "");
    return url.toLowerCase();
  }
}

/**
 * Whether two clone URLs point at the same source repository, ignoring
 * credentials, ".git" suffix, trailing slash, and host case.
 */
export function cloneUrlsMatch(a?: string | null, b?: string | null): boolean {
  const normA = normalizeCloneUrl(a);
  const normB = normalizeCloneUrl(b);
  if (!normA || !normB) return false;
  return normA === normB;
}

/**
 * Whether an existing Gitea repo is a mirror of the given GitHub source.
 * Uses Gitea's original_url (the recorded migration source) when present;
 * if Gitea didn't expose original_url, we cannot positively confirm the
 * source and return false (callers then treat the name as a genuine
 * collision rather than risk mapping onto an unrelated repo — #309).
 */
export function isMirrorOfSource(
  repoInfo: GiteaRepoInfo | null,
  sourceCloneUrl?: string | null
): boolean {
  if (!repoInfo || !repoInfo.mirror) return false;
  return cloneUrlsMatch(repoInfo.original_url, sourceCloneUrl);
}

export type CandidateNameClassification = "available" | "reusable" | "taken";

/**
 * Classify a candidate mirror name for the suffix-vs-reuse decision in
 * generateUniqueRepoName. Pure (all I/O is pre-resolved by the caller):
 *   - "available": free in Gitea and not DB-claimed by another repo → use it
 *   - "reusable":  occupied in Gitea by a mirror of THIS source, not DB-claimed
 *                  by another repo → reuse it (no suffix)
 *   - "taken":     occupied by a different source / non-mirror, or DB-claimed by
 *                  another repo → must suffix
 *
 * A DB claim by a DIFFERENT repo always blocks reuse so two users mirroring the
 * same source into a shared org stay separated.
 */
export function classifyCandidateName({
  existsInGitea,
  claimedByOther,
  repoInfo,
  sourceCloneUrl,
}: {
  existsInGitea: boolean;
  claimedByOther: boolean;
  repoInfo: GiteaRepoInfo | null;
  sourceCloneUrl?: string | null;
}): CandidateNameClassification {
  if (existsInGitea) {
    if (!claimedByOther && isMirrorOfSource(repoInfo, sourceCloneUrl)) {
      return "reusable";
    }
    return "taken";
  }

  // Not in Gitea, but possibly claimed in the DB by a concurrent operation.
  if (claimedByOther) return "taken";
  return "available";
}

export interface ExistingMirrorMatch {
  owner: string;
  repoName: string;
  repoInfo: GiteaRepoInfo;
}

/**
 * Resolve an existing same-source mirror for a repository, if one exists.
 *
 * Resolution order (backward compatible):
 *   1. The recorded repository.mirroredLocation — if it still resolves to a
 *      live mirror of THIS source, reuse it even when the base candidate name
 *      differs from the current naming strategy (handles strategy changes — #309).
 *   2. The provided candidate owner/name — if that resolves to a live mirror of
 *      THIS source, reuse it (handles the self-collision that drove suffixing — #315).
 *
 * Returns null when no live same-source mirror is found (caller should create
 * a fresh mirror, generating a unique name if the candidate name is taken by a
 * DIFFERENT source).
 */
export async function findExistingMirror({
  repository,
  config,
  candidateOwner,
  candidateName,
  getRepoInfo,
}: {
  repository: Repository;
  config: Partial<Config>;
  candidateOwner: string;
  candidateName: string;
  // Injectable for testing; defaults to the real Gitea lookup.
  getRepoInfo?: (args: {
    config: Partial<Config>;
    owner: string;
    repoName: string;
  }) => Promise<GiteaRepoInfo | null>;
}): Promise<ExistingMirrorMatch | null> {
  const lookup =
    getRepoInfo ??
    (async (args: {
      config: Partial<Config>;
      owner: string;
      repoName: string;
    }) => {
      const { getGiteaRepoInfo } = await import("@/lib/gitea-enhanced");
      return getGiteaRepoInfo(args);
    });

  const sourceCloneUrl = repository.cloneUrl;

  // Candidate locations to probe, in priority order. Dedupe so we don't issue
  // the same HTTP lookup twice when mirroredLocation equals the candidate.
  const candidates: Array<{ owner: string; repoName: string }> = [];
  const seen = new Set<string>();
  const pushCandidate = (owner?: string | null, repoName?: string | null) => {
    const o = (owner || "").trim();
    const r = (repoName || "").trim();
    if (!o || !r) return;
    const key = `${o}/${r}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ owner: o, repoName: r });
  };

  if (repository.mirroredLocation && repository.mirroredLocation.trim()) {
    const slashIndex = repository.mirroredLocation.indexOf("/");
    if (slashIndex > 0 && slashIndex < repository.mirroredLocation.length - 1) {
      pushCandidate(
        repository.mirroredLocation.slice(0, slashIndex),
        repository.mirroredLocation.slice(slashIndex + 1)
      );
    }
  }
  pushCandidate(candidateOwner, candidateName);

  for (const candidate of candidates) {
    let repoInfo: GiteaRepoInfo | null;
    try {
      repoInfo = await lookup({
        config,
        owner: candidate.owner,
        repoName: candidate.repoName,
      });
    } catch (error) {
      // A failed lookup (network/auth) should not be mistaken for "no mirror";
      // skip this candidate and let the caller fall back to its normal flow.
      console.warn(
        `[Mirror] Could not look up ${candidate.owner}/${candidate.repoName} while resolving existing mirror for ${repository.fullName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }

    if (isMirrorOfSource(repoInfo, sourceCloneUrl)) {
      return {
        owner: candidate.owner,
        repoName: candidate.repoName,
        repoInfo: repoInfo as GiteaRepoInfo,
      };
    }
  }

  return null;
}
