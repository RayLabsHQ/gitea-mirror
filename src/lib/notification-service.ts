import type { NotificationConfig } from "@/types/config";
import type { NotificationEvent } from "./providers/ntfy";
import { sendNtfyNotification } from "./providers/ntfy";
import { sendAppriseNotification } from "./providers/apprise";
import { sendGotifyNotification } from "./providers/gotify";
import { sendWebhookNotification } from "./providers/webhook";
import { db, configs } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { decrypt } from "@/lib/utils/encryption";

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

export function buildNewRepositoriesNotificationEvent({
  groupLabel,
  starred = false,
  repositoryNames,
  details,
}: {
  groupLabel?: string | null;
  /** Starred imports share one group, so the wording drops the owner. */
  starred?: boolean;
  repositoryNames: string[];
  details?: string;
}): NotificationEvent {
  const label = groupLabel || (starred ? STARRED_GROUP_LABEL : "Unknown");
  const count = repositoryNames.length;
  const listed = repositoryNames.slice(0, MAX_LISTED_NEW_REPOSITORIES);
  const overflow = repositoryNames.length - listed.length;

  return {
    title: `New Repositories: ${label}`,
    message: [
      starred
        ? `${count} new starred ${count === 1 ? "repository" : "repositories"} discovered:`
        : `${count} new ${count === 1 ? "repository" : "repositories"} discovered for ${label}:`,
      listed.map((name) => `\n- ${name}`).join(""),
      overflow > 0 ? `\n- and ${overflow} more` : "",
      details ? `\nDetails: ${details}` : "",
    ].join(""),
    type: "new_repo",
  };
}

/**
 * Notifies the user about repositories that were newly discovered and
 * imported (the "New repository discovered" event). Imports are reported per
 * owner or organization, except starred repositories, which arrive as one
 * group because their owners are arbitrary.
 *
 * Called fire-and-forget from the discovery passes, so it NEVER throws.
 */
export async function triggerNewRepositoriesNotification({
  userId,
  groupLabel,
  starred = false,
  repositoryNames,
  details,
}: {
  userId: string;
  groupLabel?: string | null;
  starred?: boolean;
  /** Full names of the repositories that were imported. */
  repositoryNames: string[];
  details?: string;
}): Promise<void> {
  try {
    if (repositoryNames.length === 0) {
      return;
    }

    const notificationConfig = await loadNotificationConfig(userId);

    if (!notificationConfig?.enabled || !notificationConfig.notifyOnNewRepo) {
      return;
    }

    const event = buildNewRepositoriesNotificationEvent({
      groupLabel,
      starred,
      repositoryNames,
      details,
    });

    await sendNotification(decryptNotificationConfig(notificationConfig), event);
  } catch (error) {
    console.error("[NotificationService] New repository notification failed:", error);
  }
}
