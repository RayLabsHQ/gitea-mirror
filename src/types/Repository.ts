import type { Repository } from "@/lib/db/schema";
import { z } from "zod";

export const repoStatusEnum = z.enum([
  "imported",
  "mirroring",
  "mirrored",
  "failed",
  "skipped",
  "ignored",  // User explicitly wants to ignore this repository
  "deleting",
  "deleted",
  "syncing",
  "synced",
  "archived",
]);

export type RepoStatus = z.infer<typeof repoStatusEnum>;

export const repositoryVisibilityEnum = z.enum([
  "public",
  "private",
  "internal",
]);

export type RepositoryVisibility = z.infer<typeof repositoryVisibilityEnum>;

export interface RepositoryApiSuccessResponse {
  success: true;
  message: string;
  repositories: Repository[];
}

export interface RepositoryApiErrorResponse {
  success: false;
  error: string;
  message?: string;
}

export type RepositoryApiResponse =
  | RepositoryApiSuccessResponse
  | RepositoryApiErrorResponse;

export interface GitRepo {
  name: string;
  fullName: string;
  url: string;
  cloneUrl: string;

  owner: string;
  organization?: string;
  mirroredLocation?: string;
  destinationOrg?: string | null;

  isPrivate: boolean;
  isForked: boolean;
  forkedFrom?: string;

  hasIssues: boolean;
  isStarred: boolean;
  isArchived: boolean;

  size: number;
  hasLFS: boolean;
  hasSubmodules: boolean;

  language?: string | null;
  description?: string | null;
  defaultBranch: string;
  visibility: RepositoryVisibility;

  status: RepoStatus;
  isDisabled?: boolean;
  lastMirrored?: Date;
  errorMessage?: string;

  createdAt: Date;
  updatedAt: Date;
}

export interface AddRepositoriesApiRequest {
  userId: string;
  repo: string;
  owner: string;
  force?: boolean;
  destinationOrg?: string;
}

export interface AddRepositoriesApiResponse {
  success: boolean;
  message: string;
  repository?: Repository;
  error?: string;
}
