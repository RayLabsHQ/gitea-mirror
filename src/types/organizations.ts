import type { Organization } from "@/lib/db/schema";
import { z } from "zod";
import type { RepoStatus } from "./Repository";
import type { SourceProviderKind } from "@/lib/source-providers/kinds";

export const membershipRoleEnum = z.enum([
  "member",
  "admin",
  "owner",
  "billing_manager",
]);

export type MembershipRole = z.infer<typeof membershipRoleEnum>;

export interface OrganizationsApiSuccessResponse {
  success: true;
  message: string;
  organizations: Organization[];
}

export interface OrganizationsApiErrorResponse {
  success: false;
  error: string;
  message?: string;
}

export type OrganizationsApiResponse =
  | OrganizationsApiSuccessResponse
  | OrganizationsApiErrorResponse;

export interface GitOrg {
  name: string;
  avatarUrl: string;
  membershipRole: MembershipRole;
  isIncluded: boolean;
  status: RepoStatus;
  repositoryCount: number;
  publicRepositoryCount?: number;
  privateRepositoryCount?: number;
  forkRepositoryCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AddOrganizationApiRequest {
  userId: string;
  org: string;
  role: MembershipRole;
  force?: boolean;
  /** Which connected source to import from; defaults to the primary source. */
  sourceId?: string;
  /** Public mode: import from this provider without any configured source. */
  provider?: SourceProviderKind;
  /** Instance URL for the provider; defaults to the provider's canonical host. */
  sourceUrl?: string;
}

export interface AddOrganizationApiResponse {
  success: boolean;
  message: string;
  organization?: Organization;
  error?: string;
}
