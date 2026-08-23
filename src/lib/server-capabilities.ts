import type { ServerType } from "@/lib/db/schema";

/**
 * Mirror content capabilities per server type, as defined in MATRIX_PLAN.md.
 *
 * Plain `git` servers sync refs (branches/tags) only — Git LFS objects are
 * additionally available when an explicit LFS endpoint is configured on the
 * server. The full forge types (GitHub, GitLab, Gitea, Forgejo) support all
 * content. A mirror pair's available options are the intersection of the
 * source and target capabilities.
 */
export type MirrorContentCapability =
  | "refs"
  | "releases"
  | "lfs"
  | "issues"
  | "pullRequests"
  | "labels"
  | "milestones"
  | "wiki";

export const ALL_CAPABILITIES: readonly MirrorContentCapability[] = [
  "refs",
  "releases",
  "lfs",
  "issues",
  "pullRequests",
  "labels",
  "milestones",
  "wiki",
];

/** Human-readable labels for UI display (settings modal, tooltips). */
export const CAPABILITY_LABELS: Record<MirrorContentCapability, string> = {
  refs: "Branches / tags (git refs)",
  releases: "Releases / tags metadata",
  lfs: "Git LFS objects",
  issues: "Issues",
  pullRequests: "Pull / merge requests",
  labels: "Labels",
  milestones: "Milestones",
  wiki: "Wiki / pages",
};

const FULL_FORGE_CAPABILITIES: readonly MirrorContentCapability[] = ALL_CAPABILITIES;

const SERVER_CAPABILITIES: Record<ServerType, readonly MirrorContentCapability[]> = {
  git: ["refs"],
  github: FULL_FORGE_CAPABILITIES,
  gitlab: FULL_FORGE_CAPABILITIES,
  gitea: FULL_FORGE_CAPABILITIES,
  forgejo: FULL_FORGE_CAPABILITIES,
};

export interface CapabilityOptions {
  /** Explicit LFS endpoint configured on the server (enables `lfs` for plain git servers). */
  lfsEndpoint?: string | null;
}

/**
 * Returns the content capabilities a single server supports. For plain `git`
 * servers, `lfs` is included only when an explicit LFS endpoint is configured.
 */
export function getServerCapabilities(
  type: ServerType,
  options: CapabilityOptions = {},
): MirrorContentCapability[] {
  const base = SERVER_CAPABILITIES[type] ?? ["refs"];
  if (type === "git" && options.lfsEndpoint) {
    return [...base, "lfs"];
  }
  return [...base];
}

export interface PairCapabilityOptions {
  sourceLfsEndpoint?: string | null;
  targetLfsEndpoint?: string | null;
}

/**
 * Returns the intersection of the source and target server capabilities —
 * the content options available for a mirror pair between them.
 */
export function getPairCapabilities(
  sourceType: ServerType,
  targetType: ServerType,
  options: PairCapabilityOptions = {},
): MirrorContentCapability[] {
  const source = getServerCapabilities(sourceType, { lfsEndpoint: options.sourceLfsEndpoint });
  const target = new Set(
    getServerCapabilities(targetType, { lfsEndpoint: options.targetLfsEndpoint }),
  );
  return source.filter((cap) => target.has(cap));
}

/**
 * Explains why a capability is unavailable for a server type — used for the
 * disabled-option tooltips in the pair settings modal.
 */
export function getCapabilityUnavailableReason(
  type: ServerType,
  capability: MirrorContentCapability,
  options: CapabilityOptions = {},
): string | null {
  if (getServerCapabilities(type, options).includes(capability)) return null;
  if (type === "git" && capability === "lfs") {
    return "Plain git servers require an explicit LFS endpoint to sync Git LFS objects.";
  }
  return `${type} servers do not support syncing ${CAPABILITY_LABELS[capability].toLowerCase()}.`;
}
