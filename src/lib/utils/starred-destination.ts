import type { StarredReposMode } from "@/types/config";

/** Where starred repositories go. Shared by the server and the settings UI. */
export const STARRED_REPOS_MODES = ["dedicated-org", "preserve-owner", "follow-strategy"] as const;

export const DEFAULT_STARRED_REPOS_MODE: StarredReposMode = "dedicated-org";

/** A missing or unknown value reads as the default, dedicated-org. */
export function normalizeStarredReposMode(value: unknown): StarredReposMode {
  return (STARRED_REPOS_MODES as readonly unknown[]).includes(value)
    ? (value as StarredReposMode)
    : DEFAULT_STARRED_REPOS_MODE;
}

/**
 * Whether a repository gets the starred placement, the starred organization
 * or its source owner, instead of the one every other repository gets. With
 * "follow-strategy" (#551) a starred repository is placed like any other:
 * its own destination, its organization's destination, then the mirror
 * strategy.
 */
export function usesStarredDestination(
  repository: { isStarred?: boolean | null },
  mode: unknown
): boolean {
  return repository.isStarred === true && normalizeStarredReposMode(mode) !== "follow-strategy";
}
