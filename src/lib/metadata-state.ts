interface MetadataComponentsState {
  releases: boolean;
  issues: boolean;
  pullRequests: boolean;
  labels: boolean;
  milestones: boolean;
}

/**
 * One-shot record of a deleted-branch backup we already took, so the
 * force-push detector knows to skip the same (branch, giteaSha) pair
 * next sync. Without this, deleted-on-GitHub branches that linger in
 * the Gitea mirror trip the detector every cycle and create a new
 * "Snapshot created" job row forever.
 */
export interface AcknowledgedDeletion {
  branch: string;
  giteaSha: string;
}

/**
 * Watermark for one metadata kind that can be fetched incrementally
 * from GitHub (#449). Both values are the time the GitHub listing
 * started, not when the pass finished, so anything that changed while
 * a long pass was running is picked up by the next one.
 */
export interface MetadataSyncCursor {
  /** Start of the last pass (full or incremental) that completed cleanly. */
  lastPassStartedAt: string;
  /** Start of the last full pass that completed cleanly. */
  lastFullPassStartedAt: string;
}

export interface MetadataSyncCursors {
  issues?: MetadataSyncCursor;
  pullRequests?: MetadataSyncCursor;
}

export interface RepositoryMetadataState {
  components: MetadataComponentsState;
  lastSyncedAt?: string;
  acknowledgedDeletions: AcknowledgedDeletion[];
  syncCursors: MetadataSyncCursors;
}

/**
 * How far before the stored watermark an incremental listing starts.
 * Covers clock skew between this host and GitHub and items whose
 * updated_at was written just before the previous listing began.
 * Reprocessing a few items twice is harmless: every write is matched
 * by its [GH-ISSUE #N] / [PR #N] marker and comments by their id.
 */
export const INCREMENTAL_SYNC_SAFETY_MARGIN_MS = 10 * 60 * 1000;

/**
 * A full pass still runs when the last one is older than this. It
 * catches what `since` cannot see, such as a label renamed on GitHub
 * (which does not touch the issues that carry it) or an issue removed
 * on the Gitea side by hand.
 */
export const FULL_METADATA_PASS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type MetadataPassPlan =
  | { mode: "full"; reason: string }
  | { mode: "incremental"; since: string };

const defaultComponents: MetadataComponentsState = {
  releases: false,
  issues: false,
  pullRequests: false,
  labels: false,
  milestones: false,
};

export function createDefaultMetadataState(): RepositoryMetadataState {
  return {
    components: { ...defaultComponents },
    acknowledgedDeletions: [],
    syncCursors: {},
  };
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseSyncCursor(raw: unknown): MetadataSyncCursor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { lastPassStartedAt, lastFullPassStartedAt } = raw as {
    lastPassStartedAt?: unknown;
    lastFullPassStartedAt?: unknown;
  };
  if (!isValidTimestamp(lastPassStartedAt) || !isValidTimestamp(lastFullPassStartedAt)) {
    return undefined;
  }
  return { lastPassStartedAt, lastFullPassStartedAt };
}

/**
 * Decide whether the next issues or pull request pass can ask GitHub
 * only for what changed. Without a usable watermark, or when the last
 * full pass is too old, the pass is full.
 */
export function planMetadataPass(
  cursor: MetadataSyncCursor | undefined,
  now: Date = new Date()
): MetadataPassPlan {
  if (!cursor) {
    return { mode: "full", reason: "no previous completed pass" };
  }
  const nowMs = now.getTime();
  const lastPassMs = Date.parse(cursor.lastPassStartedAt);
  const lastFullMs = Date.parse(cursor.lastFullPassStartedAt);
  if (!Number.isFinite(lastPassMs) || !Number.isFinite(lastFullMs)) {
    return { mode: "full", reason: "stored watermark is not a valid date" };
  }
  if (lastPassMs > nowMs + INCREMENTAL_SYNC_SAFETY_MARGIN_MS) {
    return { mode: "full", reason: "stored watermark is in the future" };
  }
  if (nowMs - lastFullMs >= FULL_METADATA_PASS_INTERVAL_MS) {
    return { mode: "full", reason: "last full pass is older than 7 days" };
  }
  return {
    mode: "incremental",
    since: new Date(lastPassMs - INCREMENTAL_SYNC_SAFETY_MARGIN_MS).toISOString(),
  };
}

/**
 * The watermark to store after a pass that completed without failures.
 * `startedAt` is the time the GitHub listing started.
 */
export function advanceMetadataSyncCursor(
  previous: MetadataSyncCursor | undefined,
  mode: MetadataPassPlan["mode"],
  startedAt: Date
): MetadataSyncCursor {
  const started = startedAt.toISOString();
  return {
    lastPassStartedAt: started,
    lastFullPassStartedAt:
      mode === "full" || !previous ? started : previous.lastFullPassStartedAt,
  };
}

export function parseRepositoryMetadataState(
  raw: unknown
): RepositoryMetadataState {
  const base = createDefaultMetadataState();

  if (!raw) {
    return base;
  }

  let parsed: any = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return base;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return base;
  }

  if (parsed.components && typeof parsed.components === "object") {
    base.components = {
      ...base.components,
      releases: Boolean(parsed.components.releases),
      issues: Boolean(parsed.components.issues),
      pullRequests: Boolean(parsed.components.pullRequests),
      labels: Boolean(parsed.components.labels),
      milestones: Boolean(parsed.components.milestones),
    };
  }

  if (typeof parsed.lastSyncedAt === "string") {
    base.lastSyncedAt = parsed.lastSyncedAt;
  } else if (typeof parsed.lastMetadataSync === "string") {
    base.lastSyncedAt = parsed.lastMetadataSync;
  }

  if (Array.isArray(parsed.acknowledgedDeletions)) {
    base.acknowledgedDeletions = parsed.acknowledgedDeletions.flatMap(
      (entry: unknown): AcknowledgedDeletion[] => {
        if (!entry || typeof entry !== "object") return [];
        const branch = (entry as { branch?: unknown }).branch;
        const giteaSha = (entry as { giteaSha?: unknown }).giteaSha;
        if (typeof branch !== "string" || typeof giteaSha !== "string") {
          return [];
        }
        return [{ branch, giteaSha }];
      }
    );
  }

  if (parsed.syncCursors && typeof parsed.syncCursors === "object") {
    const issues = parseSyncCursor(parsed.syncCursors.issues);
    const pullRequests = parseSyncCursor(parsed.syncCursors.pullRequests);
    if (issues) base.syncCursors.issues = issues;
    if (pullRequests) base.syncCursors.pullRequests = pullRequests;
  }

  return base;
}

export function serializeRepositoryMetadataState(
  state: RepositoryMetadataState
): string {
  return JSON.stringify(state);
}
