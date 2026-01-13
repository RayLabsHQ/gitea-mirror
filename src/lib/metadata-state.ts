interface MetadataComponentsState {
  releases: boolean;
  issues: boolean;
  pullRequests: boolean;
  labels: boolean;
  milestones: boolean;
}

// Extended state that tracks last sync timestamps for incremental updates
interface MetadataComponentTimestamps {
  releases?: string;
  issues?: string;
  pullRequests?: string;
  labels?: string;
  milestones?: string;
}

export interface RepositoryMetadataState {
  components: MetadataComponentsState;
  lastSyncedAt?: string;
  // Timestamps for each component to enable incremental sync
  componentLastSynced?: MetadataComponentTimestamps;
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

  // Parse component timestamps for incremental sync
  if (parsed.componentLastSynced && typeof parsed.componentLastSynced === "object") {
    base.componentLastSynced = {};
    if (typeof parsed.componentLastSynced.releases === "string") {
      base.componentLastSynced.releases = parsed.componentLastSynced.releases;
    }
    if (typeof parsed.componentLastSynced.issues === "string") {
      base.componentLastSynced.issues = parsed.componentLastSynced.issues;
    }
    if (typeof parsed.componentLastSynced.pullRequests === "string") {
      base.componentLastSynced.pullRequests = parsed.componentLastSynced.pullRequests;
    }
    if (typeof parsed.componentLastSynced.labels === "string") {
      base.componentLastSynced.labels = parsed.componentLastSynced.labels;
    }
    if (typeof parsed.componentLastSynced.milestones === "string") {
      base.componentLastSynced.milestones = parsed.componentLastSynced.milestones;
    }
  }

  return base;
}

export function serializeRepositoryMetadataState(
  state: RepositoryMetadataState
): string {
  return JSON.stringify(state);
}
