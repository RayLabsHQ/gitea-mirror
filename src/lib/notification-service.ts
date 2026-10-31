import type { NotificationConfig } from "@/types/config";
import type { NotificationEvent } from "./providers/ntfy";
import { sendNtfyNotification } from "./providers/ntfy";
import { sendAppriseNotification } from "./providers/apprise";
import { sendGotifyNotification } from "./providers/gotify";
import { sendWebhookNotification } from "./providers/webhook";
import { db, configs } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { decrypt } from "@/lib/utils/encryption";
import { STUCK_MIRROR_QUEUE_HINT } from "./mirror-sync-health";

function sanitizeTestNotificationError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Failed to send test notification";
  }

  const safeErrorPatterns = [
    /topic is required/i,
    /url and token are required/i,
    /unknown provider/i,
    /bad request/i,
    /unauthorized/i,
    /forbidden/i,
    /not found/i,
    /timeout/i,
    /network error/i,
    /invalid/i,
  ];

  if (safeErrorPatterns.some((pattern) => pattern.test(error.message))) {
    return error.message;
  }

  return "Failed to send test notification";
}

/**
 * Sends a notification using the configured provider.
 * NEVER throws -- all errors are caught and logged.
 */
export async function sendNotification(
  config: NotificationConfig,
  event: NotificationEvent,
): Promise<void> {
  try {
    if (config.provider === "ntfy") {
      if (!config.ntfy?.topic) {
        console.warn("[NotificationService] Ntfy topic is not configured, skipping notification");
        return;
      }
      await sendNtfyNotification(config.ntfy, event);
    } else if (config.provider === "apprise") {
      if (!config.apprise?.url || !config.apprise?.token) {
        console.warn("[NotificationService] Apprise URL or token is not configured, skipping notification");
        return;
      }
      await sendAppriseNotification(config.apprise, event);
    } else if (config.provider === "gotify") {
      if (!config.gotify?.url || !config.gotify?.token) {
        console.warn("[NotificationService] Gotify URL or token is not configured, skipping notification");
        return;
      }
      await sendGotifyNotification(config.gotify, event);
    } else if (config.provider === "webhook") {
      if (!config.webhook?.url) {
        console.warn("[NotificationService] Webhook URL is not configured, skipping notification");
        return;
      }
      await sendWebhookNotification(config.webhook, event);
    }
  } catch (error) {
    console.error("[NotificationService] Failed to send notification:", error);
  }
}

/**
 * Sends a test notification and returns the result.
 * Unlike sendNotification, this propagates the success/error status
 * so the UI can display the outcome.
 */
export async function testNotification(
  notificationConfig: NotificationConfig,
): Promise<{ success: boolean; error?: string }> {
  const event: NotificationEvent = {
    title: "Gitea Mirror - Test Notification",
    message: "This is a test notification from Gitea Mirror. If you see this, notifications are working correctly!",
    type: "sync_success",
  };

  try {
    if (notificationConfig.provider === "ntfy") {
      if (!notificationConfig.ntfy?.topic) {
        return { success: false, error: "Ntfy topic is required" };
      }
      await sendNtfyNotification(notificationConfig.ntfy, event);
    } else if (notificationConfig.provider === "apprise") {
      if (!notificationConfig.apprise?.url || !notificationConfig.apprise?.token) {
        return { success: false, error: "Apprise URL and token are required" };
      }
      await sendAppriseNotification(notificationConfig.apprise, event);
    } else if (notificationConfig.provider === "gotify") {
      if (!notificationConfig.gotify?.url || !notificationConfig.gotify?.token) {
        return { success: false, error: "Gotify URL and token are required" };
      }
      await sendGotifyNotification(notificationConfig.gotify, event);
    } else if (notificationConfig.provider === "webhook") {
      if (!notificationConfig.webhook?.url) {
        return { success: false, error: "Webhook URL is required" };
      }
      await sendWebhookNotification(notificationConfig.webhook, event);
    } else {
      return { success: false, error: `Unknown provider: ${notificationConfig.provider}` };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: sanitizeTestNotificationError(error) };
  }
}

/**
 * The user's stored notification config, or undefined when they have none.
 * Prefers the active and most-recently-updated row to avoid picking a stale
 * inactive stub when multiple rows exist (see issue #271).
 */
async function loadNotificationConfig(
  userId: string,
): Promise<NotificationConfig | undefined> {
  const configResults = await db
    .select()
    .from(configs)
    .where(eq(configs.userId, userId))
    .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
    .limit(1);

  if (configResults.length === 0) {
    return undefined;
  }

  return configResults[0].notificationConfig as NotificationConfig | undefined;
}

/**
 * Copy of a stored config with the ACTIVE provider's credential decrypted.
 *
 * Only the active provider is decrypted so stale credentials on the inactive
 * provider cannot drop the whole notification.
 */
function decryptNotificationConfig(
  notificationConfig: NotificationConfig,
): NotificationConfig {
  const decryptedConfig = { ...notificationConfig };
  if (decryptedConfig.provider === "ntfy" && decryptedConfig.ntfy?.token) {
    decryptedConfig.ntfy = {
      ...decryptedConfig.ntfy,
      token: decrypt(decryptedConfig.ntfy.token),
    };
  }
  if (decryptedConfig.provider === "apprise" && decryptedConfig.apprise?.token) {
    decryptedConfig.apprise = {
      ...decryptedConfig.apprise,
      token: decrypt(decryptedConfig.apprise.token),
    };
  }
  if (decryptedConfig.provider === "gotify" && decryptedConfig.gotify?.token) {
    decryptedConfig.gotify = {
      ...decryptedConfig.gotify,
      token: decrypt(decryptedConfig.gotify.token),
    };
  }
  if (decryptedConfig.provider === "webhook" && decryptedConfig.webhook?.secret) {
    decryptedConfig.webhook = {
      ...decryptedConfig.webhook,
      secret: decrypt(decryptedConfig.webhook.secret),
    };
  }
  return decryptedConfig;
}

/**
 * Loads the user's notification config from the database and triggers
 * a notification if the event type matches the user's preferences.
 *
 * NEVER throws -- all errors are caught and logged. This function is
 * designed to be called fire-and-forget from the mirror job system.
 */
export async function triggerJobNotification({
  userId,
  status,
  repositoryName,
  organizationName,
  message,
  details,
}: {
  userId: string;
  status: string;
  repositoryName?: string | null;
  organizationName?: string | null;
  message?: string;
  details?: string;
}): Promise<void> {
  try {
    // Only trigger for terminal statuses
    if (status !== "failed" && status !== "mirrored" && status !== "synced") {
      return;
    }

    const notificationConfig = await loadNotificationConfig(userId);

    if (!notificationConfig?.enabled) {
      return;
    }

    // Check event type against user preferences
    const isError = status === "failed";
    const isSuccess = status === "mirrored" || status === "synced";

    if (isError && !notificationConfig.notifyOnSyncError) {
      return;
    }
    if (isSuccess && !notificationConfig.notifyOnSyncSuccess) {
      return;
    }

    // Only decrypt the active provider's token to avoid failures from stale
    // credentials on the inactive provider dropping the entire notification
    const decryptedConfig = decryptNotificationConfig(notificationConfig);

    // Build event
    const repoLabel = repositoryName || organizationName || "Unknown";
    const eventType: NotificationEvent["type"] = isError ? "sync_error" : "sync_success";

    const event: NotificationEvent = {
      title: isError
        ? `Mirror Failed: ${repoLabel}`
        : `Mirror Success: ${repoLabel}`,
      message: [
        message || `Repository ${repoLabel} ${isError ? "failed to mirror" : "mirrored successfully"}`,
        details ? `\nDetails: ${details}` : "",
      ]
        .filter(Boolean)
        .join(""),
      type: eventType,
    };

    await sendNotification(decryptedConfig, event);
  } catch (error) {
    console.error("[NotificationService] Background notification failed:", error);
  }
}

/**
 * The "New repository discovered" event for one group of imports.
 *
 * A source can publish dozens of new repositories between two scheduler
 * ticks, so they are reported as a single notification instead of one alert
 * per repository, and the list is capped so a large import cannot bury every
 * other notification.
 */
export const MAX_LISTED_NEW_REPOSITORIES = 10;

/** Label for the single group that collects every starred import. */
export const STARRED_GROUP_LABEL = "Starred";

/**
 * Which group of discovered repositories a notification belongs to. Stars come
 * from any number of owners, so they form one group of their own.
 */
export type NewRepositoryGroupKind = "own" | "organization" | "starred";

/**
 * Whether one group reports. The group switches are sub-options of
 * notifyOnNewRepo, so a group only reports while the master switch is on. A
 * stored row that predates them has no group keys, which counts as on.
 */
export function isNewRepositoryGroupEnabled(
  config: Pick<
    NotificationConfig,
    | "enabled"
    | "notifyOnNewRepo"
    | "notifyOnNewOwnRepo"
    | "notifyOnNewOrgRepo"
    | "notifyOnNewStarredRepo"
  >,
  kind: NewRepositoryGroupKind,
): boolean {
  if (!config.enabled || config.notifyOnNewRepo !== true) {
    return false;
  }
  if (kind === "starred") {
    return config.notifyOnNewStarredRepo !== false;
  }
  if (kind === "organization") {
    return config.notifyOnNewOrgRepo !== false;
  }
  return config.notifyOnNewOwnRepo !== false;
}

export function buildNewRepositoriesNotificationEvent({
  kind,
  groupLabel,
  repositoryNames,
  details,
}: {
  kind: NewRepositoryGroupKind;
  groupLabel?: string | null;
  repositoryNames: string[];
  details?: string;
}): NotificationEvent {
  const label = kind === "starred" ? STARRED_GROUP_LABEL : groupLabel || "Unknown";
  const count = repositoryNames.length;
  const noun = count === 1 ? "repository" : "repositories";
  const listed = repositoryNames.slice(0, MAX_LISTED_NEW_REPOSITORIES);
  const overflow = repositoryNames.length - listed.length;

  return {
    title: `New Repositories: ${label}`,
    message: [
      kind === "starred"
        ? `${count} new starred ${noun} discovered:`
        : `${count} new ${noun} discovered for ${label}:`,
      listed.map((name) => `\n- ${name}`).join(""),
      overflow > 0 ? `\n- and ${overflow} more` : "",
      details ? `\nDetails: ${details}` : "",
    ].join(""),
    type: "new_repo",
  };
}

/**
 * Notifies the user about repositories that were newly discovered and
 * imported. The notifyOnNewRepo switch gates the alerts and the three group
 * switches (own, organization, starred) select which groups report; each group
 * arrives as a single notification instead of one per repository.
 *
 * Called fire-and-forget from the discovery passes, so it NEVER throws.
 */
export async function triggerNewRepositoriesNotification({
  userId,
  kind,
  groupLabel,
  repositoryNames,
  details,
}: {
  userId: string;
  kind: NewRepositoryGroupKind;
  groupLabel?: string | null;
  /** Full names of the repositories that were imported. */
  repositoryNames: string[];
  details?: string;
}): Promise<void> {
  try {
    if (repositoryNames.length === 0) {
      return;
    }

    const notificationConfig = await loadNotificationConfig(userId);

    if (!notificationConfig || !isNewRepositoryGroupEnabled(notificationConfig, kind)) {
      return;
    }

    const event = buildNewRepositoriesNotificationEvent({
      kind,
      groupLabel,
      repositoryNames,
      details,
    });

    await sendNotification(decryptNotificationConfig(notificationConfig), event);
  } catch (error) {
    console.error("[NotificationService] New repository notification failed:", error);
  }
}

/**
 * The "every mirrored release was removed" event.
 *
 * A tag or type filter change makes the retention pass delete the destination
 * releases that no longer match. When nothing survives, the sync itself
 * succeeded but the destination lost every release it had, so nothing else
 * would alert the user.
 */
export function buildAllReleasesRemovedNotificationEvent({
  repositoryName,
  destination,
  removedCount,
}: {
  repositoryName: string;
  destination: string;
  removedCount: number;
}): NotificationEvent {
  const plural = removedCount === 1 ? "" : "s";
  return {
    title: `All Releases Removed: ${repositoryName}`,
    message: [
      `${removedCount} release${plural} deleted from ${destination} by the release filters; the destination now has none.`,
      " Check the include/exclude tag patterns and the pre-release setting before the next sync.",
    ].join(""),
    type: "sync_error",
  };
}

/**
 * Warns that the release filters emptied a destination that previously had
 * releases. The existing "Sync errors" switch gates the alert.
 *
 * Called fire-and-forget from the retention pass, so it NEVER throws.
 */
export async function triggerAllReleasesRemovedNotification(args: {
  userId: string;
  repositoryName: string;
  destination: string;
  removedCount: number;
}): Promise<void> {
  try {
    if (args.removedCount <= 0) {
      return;
    }

    const notificationConfig = await loadNotificationConfig(args.userId);

    if (!notificationConfig?.enabled || !notificationConfig.notifyOnSyncError) {
      return;
    }

    const event = buildAllReleasesRemovedNotificationEvent(args);

    await sendNotification(decryptNotificationConfig(notificationConfig), event);
  } catch (error) {
    console.error("[NotificationService] All-releases-removed notification failed:", error);
  }
}

/**
 * The "Gitea never ran the requested sync" event (#493).
 *
 * A stuck mirror queue holds back every repository at once, so the text
 * points at the queue rather than the one repository that happened to be
 * checked first.
 */
export function buildMirrorSyncStalledNotificationEvent({
  repositoryName,
  destination,
  waited,
  mirrorUpdated,
}: {
  repositoryName: string;
  destination: string;
  /** How long ago the request was accepted, already formatted. */
  waited: string;
  mirrorUpdated: string;
}): NotificationEvent {
  return {
    title: `Mirror Sync Stalled: ${repositoryName}`,
    message: [
      `Gitea has not run the sync requested for ${destination} ${waited} ago; its last mirror run is still ${mirrorUpdated}.`,
      ` ${STUCK_MIRROR_QUEUE_HINT}`,
      " Other repositories held back by the same queue are listed in the Activity Log.",
    ].join(""),
    type: "sync_error",
  };
}

/**
 * At most one stalled-sync alert per user in this window. Every repository
 * reports its own stall in the activity log; the push channels only need to
 * hear that something is wrong.
 */
export const MIRROR_SYNC_STALLED_NOTIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const lastMirrorSyncStalledNotification = new Map<string, number>();

/**
 * Takes this user's alert slot when the last alert is outside the window.
 * Kept in memory: a restart allows one more alert, which is fine.
 */
export function claimMirrorSyncStalledNotification(userId: string, now: number = Date.now()): boolean {
  const last = lastMirrorSyncStalledNotification.get(userId);
  if (last !== undefined && now - last < MIRROR_SYNC_STALLED_NOTIFICATION_INTERVAL_MS) {
    return false;
  }
  lastMirrorSyncStalledNotification.set(userId, now);
  return true;
}

/** Test hook: forget when each user was last alerted. */
export function resetMirrorSyncStalledNotifications(): void {
  lastMirrorSyncStalledNotification.clear();
}

/**
 * Warns that Gitea accepted a sync request but never ran it. The existing
 * "Sync errors" switch gates the alert.
 *
 * Called fire-and-forget from the sync path, so it NEVER throws.
 */
export async function triggerMirrorSyncStalledNotification(args: {
  userId: string;
  repositoryName: string;
  destination: string;
  waited: string;
  mirrorUpdated: string;
}): Promise<void> {
  try {
    const notificationConfig = await loadNotificationConfig(args.userId);

    if (!notificationConfig?.enabled || !notificationConfig.notifyOnSyncError) {
      return;
    }
    if (!claimMirrorSyncStalledNotification(args.userId)) {
      return;
    }

    const event = buildMirrorSyncStalledNotificationEvent(args);

    await sendNotification(decryptNotificationConfig(notificationConfig), event);
  } catch (error) {
    console.error("[NotificationService] Mirror sync stalled notification failed:", error);
  }
}
