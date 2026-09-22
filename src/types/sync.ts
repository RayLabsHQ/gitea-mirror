import type { Organization, Repository } from "@/lib/db/schema";

export interface SyncRepoRequest {
  userId: string;
  repositoryIds: string[];
}

export interface SyncRepoResponse {
  success: boolean;
  error?: string;
  message?: string;
  repositories: Repository[];
}

export interface SyncOrgRequest {
  orgId: string;
}

/** What a manual organization sync put in the queue when it answered. */
export interface SyncOrgQueuedCounts {
  /** Repositories that were never mirrored and get an initial mirror. */
  mirror: number;
  /** Repositories already on the destination that get a refresh. */
  sync: number;
  /** Repositories the run leaves alone (in flight, ignored, being deleted). */
  skipped: number;
}

export interface SyncOrgResponse {
  success: boolean;
  error?: string;
  message?: string;
  organization?: Organization;
  queued?: SyncOrgQueuedCounts;
}

export interface ScheduleSyncRepoRequest {
  userId: string;
}

export interface ScheduleSyncRepoResponse {
  success: boolean;
  error?: string;
  message?: string;
  repositories: Repository[];
}
