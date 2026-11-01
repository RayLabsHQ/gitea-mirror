import type { Repository } from "@/lib/db/schema";
import type { Organization } from "@/lib/db/schema";
import type { MirrorJob } from "@/lib/db/schema";

/**
 * The most repositories and activities the dashboard API returns. The
 * dashboard shows as many as fit on the screen, up to this.
 */
export const DASHBOARD_LIST_LIMIT = 50;

export interface DashboardApiSuccessResponse {
  success: true;
  message: string;
  repoCount: number;
  orgCount: number;
  mirroredCount: number;
  repositories: Repository[];
  organizations: Organization[];
  activities: MirrorJob[];
  lastSync: Date | null;
}

export interface DashboardApiErrorResponse {
  success: false;
  error: string;
  message?: string;
}

export type DashboardApiResponse =
  | DashboardApiSuccessResponse
  | DashboardApiErrorResponse;
