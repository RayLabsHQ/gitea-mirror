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

/**
 * Progress of an issues or pull request pass that did not finish, most
 * often because the source ran out of rate limit budget (#449 follow-up).
 * The next run repeats the same pass and skips the items listed in
 * `done`, as long as they have not changed since `startedAt`, so a pass
 * over a large repository gets further every run instead of starting
 * over each time.
 */
export interface MetadataPassProgress {
  mode: MetadataPassPlan["mode"];
  /** Listing start for an incremental pass; repeated as is on resume. */
  since?: string;
  /**
   * When the listing of the first attempt started. Used as the watermark
   * once the pass completes, so nothing that changed while it was
   * interrupted is missed.
   */
  startedAt: string;
  /** GitHub numbers finished by this pass, as inclusive ranges. */
  done: Array<[number, number]>;
}

export interface MetadataPassProgressByKind {
  issues?: MetadataPassProgress;
  pullRequests?: MetadataPassProgress;
}

export interface RepositoryMetadataState {
  components: MetadataComponentsState;
  lastSyncedAt?: string;
  acknowledgedDeletions: AcknowledgedDeletion[];
  syncCursors: MetadataSyncCursors;
  passProgress: MetadataPassProgressByKind;
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
    passProgress: {},
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
 * Collapse item numbers into sorted inclusive ranges, so a pass over
 * thousands of issues stores a handful of pairs.
 */
export function toNumberRanges(numbers: Iterable<number>): Array<[number, number]> {
  const sorted = [...new Set(numbers)]
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) {
      last[1] = n;
    } else {
      ranges.push([n, n]);
    }
  }
  return ranges;
}

export function numberInRanges(n: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([from, to]) => n >= from && n <= to);
}

function parsePassProgress(raw: unknown): MetadataPassProgress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { mode, since, startedAt, done } = raw as {
    mode?: unknown;
    since?: unknown;
    startedAt?: unknown;
    done?: unknown;
  };
  if (mode !== "full" && mode !== "incremental") return undefined;
  if (!isValidTimestamp(startedAt)) return undefined;
  if (mode === "incremental" && !isValidTimestamp(since)) return undefined;
  if (!Array.isArray(done)) return undefined;
  const ranges = done.filter(
    (entry): entry is [number, number] =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      Number.isInteger(entry[0]) &&
      Number.isInteger(entry[1]) &&
      entry[0] <= entry[1]
  );
  return mode === "incremental"
    ? { mode, since: since as string, startedAt, done: ranges }
    : { mode, startedAt, done: ranges };
}

/**
 * Plan a pass, picking up an unfinished one when there is one. A resumed
 * pass keeps its mode and `since`, and reports its original start so the
 * watermark stored at the end covers the whole interrupted window.
 */
export function planMetadataPassWithProgress(
  cursor: MetadataSyncCursor | undefined,
  progress: MetadataPassProgress | undefined,
  now: Date = new Date()
): { plan: MetadataPassPlan; startedAt: Date; resume?: MetadataPassProgress } {
  const startedAtMs = progress ? Date.parse(progress.startedAt) : NaN;
  if (progress && Number.isFinite(startedAtMs) && startedAtMs <= now.getTime()) {
    const plan: MetadataPassPlan =
      progress.mode === "incremental" && progress.since
        ? { mode: "incremental", since: progress.since }
        : { mode: "full", reason: "resuming a full pass that did not finish" };
    return { plan, startedAt: new Date(startedAtMs), resume: progress };
  }
  return { plan: planMetadataPass(cursor, now), startedAt: now };
}

/**
 * Decides how much work an item needs in the current pass.
 *
 * - "skip": a resumed pass already finished it and it has not changed
 *   since that pass started.
 * - "unchanged": a full pass is revisiting an item that is already in
 *   Gitea and has not changed since the last completed pass. Its
 *   comments, commits and files cannot have changed either (each of
 *   those bumps updated_at), so no per-item source call is needed.
 * - "sync": everything else gets the full treatment.
 */
export function classifyPassItem({
  number,
  updatedAt,
  plan,
  cursor,
  resume,
  existsInDestination,
}: {
  number: number;
  updatedAt: string | null | undefined;
  plan: MetadataPassPlan;
  cursor: MetadataSyncCursor | undefined;
  resume: MetadataPassProgress | undefined;
  existsInDestination: boolean;
}): "skip" | "unchanged" | "sync" {
  const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(updatedMs)) return "sync";

  if (resume && numberInRanges(number, resume.done)) {
    const resumeStartMs = Date.parse(resume.startedAt);
    if (updatedMs < resumeStartMs - INCREMENTAL_SYNC_SAFETY_MARGIN_MS) {
      return "skip";
    }
  }

  if (plan.mode === "full" && cursor && existsInDestination) {
    const lastPassMs = Date.parse(cursor.lastPassStartedAt);
    if (
      Number.isFinite(lastPassMs) &&
      updatedMs < lastPassMs - INCREMENTAL_SYNC_SAFETY_MARGIN_MS
    ) {
      return "unchanged";
    }
  }

  return "sync";
}

/**
 * Progress to store for a pass that did not finish. Numbers finished by
 * an earlier attempt of the same pass are kept.
 */
export function buildPassProgress(
  plan: MetadataPassPlan,
  startedAt: Date,
  completed: Iterable<number>,
  resume: MetadataPassProgress | undefined
): MetadataPassProgress {
  const numbers = new Set<number>(completed);
  for (const [from, to] of resume?.done ?? []) {
    for (let n = from; n <= to; n++) numbers.add(n);
  }
  return {
    mode: plan.mode,
    ...(plan.mode === "incremental" ? { since: plan.since } : {}),
    startedAt: startedAt.toISOString(),
    done: toNumberRanges(numbers),
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

  if (parsed.passProgress && typeof parsed.passProgress === "object") {
    const issues = parsePassProgress(parsed.passProgress.issues);
    const pullRequests = parsePassProgress(parsed.passProgress.pullRequests);
    if (issues) base.passProgress.issues = issues;
    if (pullRequests) base.passProgress.pullRequests = pullRequests;
  }

  return base;
}

export function serializeRepositoryMetadataState(
  state: RepositoryMetadataState
): string {
  return JSON.stringify(state);
}
