import type { Config } from "@/types/config";
import type { MirrorOverrides, Repository } from "@/lib/db/schema";
import { mirrorOverridesSchema } from "@/lib/db/schema";

/**
 * The mirror option flags that can be overridden per organization and per
 * repository. These mirror the flag names on `giteaConfigSchema` so the
 * resolver can read both tiers with the same key.
 */
export const MIRROR_OVERRIDE_KEYS = [
  "lfs",
  "wiki",
  "mirrorReleases",
  "mirrorMetadata",
  "mirrorIssues",
  "mirrorPullRequests",
  "mirrorLabels",
  "mirrorMilestones",
] as const;

export type MirrorOverrideKey = (typeof MIRROR_OVERRIDE_KEYS)[number];

/** Fully resolved mirror options: every flag has a definite boolean value. */
export type ResolvedMirrorOptions = Record<MirrorOverrideKey, boolean>;

/**
 * Flags the starred-code-only clamp forces off.
 *
 * Shared by the resolver and the UI gating helper so the two cannot drift.
 * `lfs` is deliberately absent: LFS is repository content, not metadata, and
 * turning it off per repository is the entire point of issue #361. It must
 * stay editable for starred repos.
 */
export const STARRED_CLAMPED_KEYS = [
  "wiki",
  "mirrorReleases",
  "mirrorMetadata",
  "mirrorIssues",
  "mirrorPullRequests",
  "mirrorLabels",
  "mirrorMilestones",
] as const satisfies readonly MirrorOverrideKey[];

/**
 * Flags surfaced in the override UI.
 *
 * `mirrorMetadata` is intentionally excluded. It is a write-time master switch
 * in the global settings UI (config-mapper ANDs it into the individual flags
 * when the config is saved) and is never read by the mirror paths in gitea.ts
 * or gitea-enhanced.ts. A per-object override for it would resolve correctly
 * and then change nothing, which is exactly the silent no-op this UI is meant
 * to avoid.
 */
export const UI_MIRROR_OVERRIDE_KEYS: MirrorOverrideKey[] = [
  "lfs",
  "wiki",
  "mirrorIssues",
  "mirrorPullRequests",
  "mirrorReleases",
  "mirrorLabels",
  "mirrorMilestones",
];

/** Reasons a toggle is disabled. Shown verbatim in the dialog. */
export const MIRROR_GATING_REASONS = {
  starredCodeOnly:
    "Starred repos mirror code only (Advanced Options > starred code only)",
  labelsFollowIssues: "Issues mirroring already syncs labels",
} as const;

/** key -> reason it cannot take effect. Absent key means editable. */
export type MirrorOverrideGating = Partial<Record<MirrorOverrideKey, string>>;

/**
 * Decide which toggles cannot take effect, and why.
 *
 * This is the single source of truth behind the rule that a toggle which
 * cannot take effect is disabled with a reason rather than silently ignored.
 * It mirrors the real runtime behavior:
 *
 *  - the starred clamp in `resolveMirrorOptions` forces STARRED_CLAMPED_KEYS
 *    off for starred repos when starredCodeOnly is set, outranking any override
 *  - `shouldMirrorLabels` in gitea.ts / gitea-enhanced.ts is
 *    `mirrorLabels && !mirrorIssues`, so labels cannot take effect while issues
 *    are being mirrored (the issue path already reconciles labels)
 *
 * `effective` is the value each flag currently resolves to including the
 * in-progress edit, so the labels gate reacts live as issues is toggled.
 */
export function getMirrorOverrideGating({
  targetKind,
  isStarred,
  starredCodeOnly,
  effective,
}: {
  targetKind: "repository" | "organization";
  isStarred?: boolean;
  starredCodeOnly?: boolean;
  effective: Partial<Record<MirrorOverrideKey, boolean>>;
}): MirrorOverrideGating {
  const gating: MirrorOverrideGating = {};

  // Organizations are never starred, so the clamp cannot apply to them.
  const starredClampApplies =
    targetKind === "repository" && !!isStarred && !!starredCodeOnly;

  if (starredClampApplies) {
    for (const key of STARRED_CLAMPED_KEYS) {
      gating[key] = MIRROR_GATING_REASONS.starredCodeOnly;
    }
  }

  // Labels ride along with issues. Only report this when the more fundamental
  // starred clamp has not already disabled the toggle.
  if (!gating.mirrorLabels && effective.mirrorIssues) {
    gating.mirrorLabels = MIRROR_GATING_REASONS.labelsFollowIssues;
  }

  return gating;
}

export const MIRROR_OVERRIDE_LABELS: Record<MirrorOverrideKey, string> = {
  lfs: "Git LFS files",
  wiki: "Wiki",
  mirrorReleases: "Releases",
  mirrorMetadata: "Metadata",
  mirrorIssues: "Issues",
  mirrorPullRequests: "Pull requests",
  mirrorLabels: "Labels",
  mirrorMilestones: "Milestones",
};

/**
 * Normalize a persisted overrides value into a plain object.
 *
 * The column is JSON-mode, so Drizzle hands back an object, but rows written
 * before this feature (or by a raw SQL path) may hold a string or NULL. Invalid
 * shapes degrade to "no overrides" rather than throwing, because a malformed
 * override must never be able to break a mirror run.
 */
export function parseMirrorOverrides(
  value: unknown
): MirrorOverrides | null {
  if (value == null) return null;

  let candidate = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof candidate !== "object" || Array.isArray(candidate)) return null;

  const parsed = mirrorOverridesSchema.safeParse(candidate);
  if (!parsed.success) return null;

  return parsed.data;
}

/** True when the overrides object actually pins at least one flag. */
export function hasMirrorOverrides(value: unknown): boolean {
  const overrides = parseMirrorOverrides(value);
  if (!overrides) return false;
  return MIRROR_OVERRIDE_KEYS.some((key) => overrides[key] != null);
}

/** The keys an overrides object pins, for badges and summaries. */
export function listOverriddenKeys(value: unknown): MirrorOverrideKey[] {
  const overrides = parseMirrorOverrides(value);
  if (!overrides) return [];
  return MIRROR_OVERRIDE_KEYS.filter((key) => overrides[key] != null);
}

/**
 * Strip flags that are null/undefined so only genuine pins are stored, and
 * collapse an empty result to null. Keeps "no overrides" as a single canonical
 * representation instead of `{}` vs `{lfs: null}` vs NULL.
 */
export function normalizeMirrorOverrides(
  value: unknown
): MirrorOverrides | null {
  const overrides = parseMirrorOverrides(value);
  if (!overrides) return null;

  const cleaned: MirrorOverrides = {};
  for (const key of MIRROR_OVERRIDE_KEYS) {
    const flag = overrides[key];
    if (typeof flag === "boolean") cleaned[key] = flag;
  }

  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/**
 * Resolve the effective mirror options for one repository.
 *
 * Precedence is per flag, most specific tier wins:
 *   repository override -> organization override -> global config -> false
 *
 * `starredCodeOnly` is applied last as a hard clamp. It is a "code only, no
 * metadata" switch for starred repos, so it forces every metadata flag off
 * regardless of what any tier asked for. That preserves the pre-existing
 * behavior of `skipMetadataForStarred`, which this function subsumes.
 *
 * Pure and synchronous by design: the organization overrides are fetched by
 * the caller (see `loadOrganizationMirrorOverrides`) so this stays trivially
 * testable.
 */
export function resolveMirrorOptions({
  config,
  repository,
  orgOverrides,
}: {
  config: Partial<Config>;
  repository: Pick<Repository, "isStarred" | "mirrorOverrides">;
  orgOverrides?: unknown;
}): ResolvedMirrorOptions {
  const globalConfig = config.giteaConfig;
  const org = parseMirrorOverrides(orgOverrides);
  const repo = parseMirrorOverrides(repository.mirrorOverrides);

  const resolved = {} as ResolvedMirrorOptions;

  for (const key of MIRROR_OVERRIDE_KEYS) {
    const repoValue = repo?.[key];
    const orgValue = org?.[key];

    if (typeof repoValue === "boolean") {
      resolved[key] = repoValue;
    } else if (typeof orgValue === "boolean") {
      resolved[key] = orgValue;
    } else {
      resolved[key] = !!globalConfig?.[key];
    }
  }

  // Starred repos with starredCodeOnly mirror code and nothing else. This
  // clamp intentionally outranks explicit per-repo overrides: the setting
  // exists to stop starred repos from dragging in metadata wholesale.
  const skipMetadataForStarred =
    !!repository.isStarred && !!config.githubConfig?.starredCodeOnly;

  if (skipMetadataForStarred) {
    // STARRED_CLAMPED_KEYS is shared with getMirrorOverrideGating so the set of
    // flags the UI disables always matches the set the runtime forces off.
    // Note it excludes `lfs` by design.
    for (const key of STARRED_CLAMPED_KEYS) {
      resolved[key] = false;
    }
  }

  return resolved;
}

/**
 * Fetch the organization-tier overrides for a repository, if it belongs to one.
 *
 * Returns null for personal repos, unknown orgs, or when the org has no
 * overrides set. Failures are swallowed to null: a DB hiccup reading an
 * optional override must not fail the mirror.
 */
export async function loadOrganizationMirrorOverrides({
  organizationName,
  userId,
}: {
  organizationName?: string | null;
  userId?: string;
}): Promise<MirrorOverrides | null> {
  if (!organizationName || !userId) return null;

  try {
    const { db, organizations } = await import("@/lib/db");
    const { and, eq } = await import("drizzle-orm");

    const [org] = await db
      .select({ mirrorOverrides: organizations.mirrorOverrides })
      .from(organizations)
      .where(
        and(
          eq(organizations.userId, userId),
          eq(organizations.name, organizationName)
        )
      )
      .limit(1);

    return parseMirrorOverrides(org?.mirrorOverrides);
  } catch (error) {
    console.error(
      `[MirrorOverrides] Failed to load organization overrides for ${organizationName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Convenience wrapper: load the org tier then resolve. This is what the mirror
 * paths in gitea.ts call.
 */
export async function resolveMirrorOptionsForRepository({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: Repository;
}): Promise<ResolvedMirrorOptions> {
  const orgOverrides = await loadOrganizationMirrorOverrides({
    organizationName: repository.organization,
    userId: config.userId,
  });

  return resolveMirrorOptions({ config, repository, orgOverrides });
}
