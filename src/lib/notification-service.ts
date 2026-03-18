import type { NotificationConfig } from "@/types/config";
import type { NotificationEvent } from "./providers/ntfy";
import { sendNtfyNotification } from "./providers/ntfy";
import { sendAppriseNotification } from "./providers/apprise";
import { db, configs } from "@/lib/db";
import { eq } from "drizzle-orm";
import { decrypt } from "@/lib/utils/encryption";

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
    } else {
      return { success: false, error: `Unknown provider: ${notificationConfig.provider}` };
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
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

    // Fetch user's config from database
    const configResults = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    if (configResults.length === 0) {
      return;
    }

    const userConfig = configResults[0];
    const notificationConfig = userConfig.notificationConfig as NotificationConfig | undefined;

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
