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

export interface RepositoryMetadataState {
  components: MetadataComponentsState;
  lastSyncedAt?: string;
  acknowledgedDeletions: AcknowledgedDeletion[];
}

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

  return base;
}

export function serializeRepositoryMetadataState(
  state: RepositoryMetadataState
): string {
  return JSON.stringify(state);
}
