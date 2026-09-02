import type { Config } from "@/types/config";
import type { MirrorOverrides, Repository } from "@/lib/db/schema";
import { mirrorOverridesSchema } from "@/lib/db/schema";
import { normalizeSourceProviderKind } from "@/lib/source-providers/kinds";

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

/**
 * The numeric mirror options that can be overridden per organization and per
 * repository. Kept apart from the boolean flags because every consumer of
 * MIRROR_OVERRIDE_KEYS (resolver, gating, dialog tri-states) assumes booleans.
 *
 * `releaseLimit` is how many of the newest releases exist in Gitea at all.
 * `releaseAssetLimit` (#311) is how many of those also get their assets
 * uploaded; the rest are created with notes and tag only.
 */
export const MIRROR_OVERRIDE_LIMIT_KEYS = ["releaseLimit", "releaseAssetLimit"] as const;

export type MirrorOverrideLimitKey = (typeof MIRROR_OVERRIDE_LIMIT_KEYS)[number];

/** Matches `giteaConfigSchema.releaseLimit`'s default. */
export const DEFAULT_RELEASE_LIMIT = 10;

/**
 * Fully resolved mirror options: every flag has a definite boolean value, the
 * release limit a definite positive integer, and the asset limit either a
 * non-negative integer or `null` for "assets for every mirrored release".
 */
export type ResolvedMirrorOptions = Record<MirrorOverrideKey, boolean> & {
  releaseLimit: number;
  releaseAssetLimit: number | null;
};

/**
 * The values the tiers above an override resolve to right now. Used by the
 * dialog to label what "Inherit" means for each row. A `null` asset limit is
 * a known value ("all"), distinct from `undefined` (not known yet).
 */
export type InheritedMirrorOptions = Partial<Record<MirrorOverrideKey, boolean>> & {
  releaseLimit?: number;
  releaseAssetLimit?: number | null;
};

/**
 * Sanitize a release limit from any tier into a positive integer, or
 * `undefined` when the value is absent or unusable (so the next tier out is
 * consulted). Floors fractional input rather than rejecting it, matching what
 * `mirrorGitHubReleasesToGitea` has always done with the global value.
 */
export function normalizeReleaseLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const limit = Math.floor(value);
  return limit >= 1 ? limit : undefined;
}

/**
 * Sanitize a release asset limit from any tier into a non-negative integer,
 * or `undefined` when the value is absent or unusable (so the next tier out
 * is consulted). Unlike the release limit, 0 is meaningful here: it means
 * release notes only, no assets. There is no numeric "all"; that is what the
 * absence of a limit at every tier (`null`) resolves to.
 */
export function normalizeReleaseAssetLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const limit = Math.floor(value);
  return limit >= 0 ? limit : undefined;
}

/** Per-key sanitizers for the numeric overrides. */
const LIMIT_NORMALIZERS: Record<
  MirrorOverrideLimitKey,
  (value: unknown) => number | undefined
> = {
  releaseLimit: normalizeReleaseLimit,
  releaseAssetLimit: normalizeReleaseAssetLimit,
};

/**
 * Whether the release at `index` in the newest-first list gets its assets
 * uploaded. `null` means no limit. A release past the limit still gets its
 * notes and tag, and assets that already reached Gitea are never removed
 * because of this rule; it only decides whether a sync uploads.
 */
export function releaseGetsAssets(
  index: number,
  releaseAssetLimit: number | null
): boolean {
  return releaseAssetLimit === null || index < releaseAssetLimit;
}

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
 * Flags that only work for GitHub sources.
 *
 * Issue, pull request, release, label and milestone mirroring read the
 * GitHub API. A repository from GitLab or Gitea gets code, wiki and LFS
 * through the Gitea pull mirror and nothing else, so the resolver forces
 * these off for it regardless of what any tier asked for.
 */
export const GITHUB_ONLY_METADATA_KEYS = [
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

/**
 * Convert the API's `mirrorOptions` shape into the flag keys used everywhere
 * else.
 *
 * `/api/config` does not return the mirror flags on `giteaConfig`. On the way
 * out, `mapDbToUiConfig` reshapes them into `mirrorOptions`, which uses
 * different names (`mirrorLFS`, not `lfs`) and nests the metadata flags under
 * `metadataComponents` with short names (`issues`, not `mirrorIssues`). Client
 * code reading `giteaConfig.lfs` therefore gets `undefined`, not `false`, which
 * is indistinguishable from "off" once coerced.
 *
 * The mapping is 1:1 with the fields the runtime reads. `metadataComponents.*`
 * carries the raw stored values (`issues` is `giteaConfig.mirrorIssues`
 * untouched), so passing them straight through reproduces exactly what
 * gitea.ts and gitea-enhanced.ts will do.
 *
 * Deliberately does NOT AND the components with `mirrorMetadata`. That switch
 * is a write-path concern: `mapUiToDbConfig` already applies it when
 * persisting, so a config saved through the settings UI has it baked into the
 * stored flag. Applying it again on read double-applies it. That is invisible
 * while the stored state is self-consistent, and wrong when it is not, which
 * is reachable via env vars: MIRROR_METADATA=false with MIRROR_ISSUES=true
 * stores `mirrorMetadata:false, mirrorIssues:true`, and the runtime mirrors
 * issues. A second AND here would report "off" for something that is on.
 */
export function mirrorOptionsToFlags(
  mirrorOptions:
    | {
        mirrorLFS?: boolean;
        mirrorReleases?: boolean;
        releaseLimit?: number;
        releaseAssetLimit?: number | null;
        mirrorMetadata?: boolean;
        metadataComponents?: {
          issues?: boolean;
          pullRequests?: boolean;
          labels?: boolean;
          milestones?: boolean;
          wiki?: boolean;
        };
      }
    | null
    | undefined
): InheritedMirrorOptions {
  const components = mirrorOptions?.metadataComponents;

  // Straight through: each field is the raw stored value the runtime reads.
  return {
    lfs: !!mirrorOptions?.mirrorLFS,
    mirrorReleases: !!mirrorOptions?.mirrorReleases,
    wiki: !!components?.wiki,
    mirrorIssues: !!components?.issues,
    mirrorPullRequests: !!components?.pullRequests,
    mirrorLabels: !!components?.labels,
    mirrorMilestones: !!components?.milestones,
    releaseLimit:
      normalizeReleaseLimit(mirrorOptions?.releaseLimit) ?? DEFAULT_RELEASE_LIMIT,
    releaseAssetLimit:
      normalizeReleaseAssetLimit(mirrorOptions?.releaseAssetLimit) ?? null,
  };
}

/** Reasons a toggle is disabled. Shown verbatim in the dialog. */
export const MIRROR_GATING_REASONS = {
  starredCodeOnly:
    "Starred repos mirror code only (Advanced Options > starred code only)",
  labelsFollowIssues: "Issues mirroring already syncs labels",
  releasesOff: "Releases are not being mirrored",
} as const;

/** key -> reason it cannot take effect. Absent key means editable. */
export type MirrorOverrideGating = Partial<
  Record<MirrorOverrideKey | MirrorOverrideLimitKey, string>
>;

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
 *  - `releaseLimit` and `releaseAssetLimit` are only read inside the release
 *    mirror, so they cannot take effect while `mirrorReleases` resolves to off
 *
 * `effective` is the value each flag currently resolves to including the
 * in-progress edit, so the labels and release-limit gates react live as
 * issues / releases are toggled.
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
  effective: InheritedMirrorOptions;
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

  // The release limit rides along with releases: inherit the starred reason
  // when that is what disabled releases, otherwise report releases being off.
  // Only an explicit `false` counts; an unknown value leaves the field open.
  if (gating.mirrorReleases) {
    gating.releaseLimit = gating.mirrorReleases;
  } else if (effective.mirrorReleases === false) {
    gating.releaseLimit = MIRROR_GATING_REASONS.releasesOff;
  }
  // The asset limit is read in the same place, so it shares the reason.
  if (gating.releaseLimit) {
    gating.releaseAssetLimit = gating.releaseLimit;
  }

  return gating;
}

export const MIRROR_OVERRIDE_LABELS: Record<
  MirrorOverrideKey | MirrorOverrideLimitKey,
  string
> = {
  lfs: "Git LFS files",
  wiki: "Wiki",
  mirrorReleases: "Releases",
  mirrorMetadata: "Metadata",
  mirrorIssues: "Issues",
  mirrorPullRequests: "Pull requests",
  mirrorLabels: "Labels",
  mirrorMilestones: "Milestones",
  releaseLimit: "Release limit",
  releaseAssetLimit: "Release asset limit",
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

/** True when the overrides object actually pins at least one field. */
export function hasMirrorOverrides(value: unknown): boolean {
  return listOverriddenKeys(value).length > 0;
}

/** The keys an overrides object pins, for badges and summaries. */
export function listOverriddenKeys(
  value: unknown
): (MirrorOverrideKey | MirrorOverrideLimitKey)[] {
  const overrides = parseMirrorOverrides(value);
  if (!overrides) return [];
  return [
    ...MIRROR_OVERRIDE_KEYS.filter((key) => overrides[key] != null),
    ...MIRROR_OVERRIDE_LIMIT_KEYS.filter(
      (key) => LIMIT_NORMALIZERS[key](overrides[key]) !== undefined
    ),
  ];
}

/**
 * Strip fields that are null/undefined (or, for limits, unusable) so only
 * genuine pins are stored, and collapse an empty result to null. Keeps "no
 * overrides" as a single canonical representation instead of `{}` vs
 * `{lfs: null}` vs NULL.
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
  for (const key of MIRROR_OVERRIDE_LIMIT_KEYS) {
    const limit = LIMIT_NORMALIZERS[key](overrides[key]);
    if (limit !== undefined) cleaned[key] = limit;
  }

  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/**
 * Resolve the effective mirror options for one repository.
 *
 * Precedence is per field, most specific tier wins:
 *   repository override -> organization override -> global config -> default
 * where the default is `false` for flags, DEFAULT_RELEASE_LIMIT for the
 * release limit, and `null` (every mirrored release) for the asset limit.
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
  repository: Pick<Repository, "isStarred" | "mirrorOverrides"> &
    Partial<Pick<Repository, "sourceProvider">>;
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

  // Same precedence for the release limit. An unusable value at any tier
  // (0, negative, NaN) falls through to the next one instead of being clamped
  // up to 1, so a bad override cannot silently shrink a repo to one release.
  resolved.releaseLimit =
    normalizeReleaseLimit(repo?.releaseLimit) ??
    normalizeReleaseLimit(org?.releaseLimit) ??
    normalizeReleaseLimit(globalConfig?.releaseLimit) ??
    DEFAULT_RELEASE_LIMIT;

  // The asset limit has no numeric default: when no tier pins one, every
  // mirrored release gets its assets, which is what happened before #311.
  // A pinned 0 is a real value (notes only) and must not fall through.
  resolved.releaseAssetLimit =
    normalizeReleaseAssetLimit(repo?.releaseAssetLimit) ??
    normalizeReleaseAssetLimit(org?.releaseAssetLimit) ??
    normalizeReleaseAssetLimit(globalConfig?.releaseAssetLimit) ??
    null;

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

  // Metadata mirroring needs the GitHub API. Rows without a source
  // provider predate the column and came from GitHub.
  if (normalizeSourceProviderKind(repository.sourceProvider) !== "github") {
    for (const key of GITHUB_ONLY_METADATA_KEYS) {
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
