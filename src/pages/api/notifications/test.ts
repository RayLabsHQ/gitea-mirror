import type { APIRoute } from "astro";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { testNotification } from "@/lib/notification-service";
import { notificationConfigSchema } from "@/lib/db/schema";
import { createSecureErrorResponse } from "@/lib/utils";
import {
  SecretHostChangedError,
  takeRemovedNotificationSecrets,
  withSavedNotificationSecrets,
} from "@/lib/utils/stored-secrets";

/**
 * The user's saved notification config, secrets still encrypted. Imported
 * lazily, like sources-api, so per-file module mocks keep working.
 */
async function loadSavedNotificationConfig(userId: string): Promise<Record<string, any> | null> {
  const [{ db, configs }, { eq, sql }] = await Promise.all([
    import("@/lib/db"),
    import("drizzle-orm"),
  ]);
  const [row] = await db
    .select({ notificationConfig: configs.notificationConfig })
    .from(configs)
    .where(eq(configs.userId, userId))
    .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
    .limit(1);
  return (row?.notificationConfig as Record<string, any> | null | undefined) ?? null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const body = await request.json();
    const { notificationConfig } = body;

    if (!notificationConfig) {
      return new Response(
        JSON.stringify({ success: false, error: "notificationConfig is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { config: rawConfig, removed } = takeRemovedNotificationSecrets(notificationConfig);
    const parsed = notificationConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ success: false, error: `Invalid config: ${parsed.error.message}` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Secrets are write-only, so the form sends an empty field for a saved
    // one; fill it in, but only for the address it was saved for.
    let testConfig: typeof parsed.data;
    try {
      testConfig = withSavedNotificationSecrets(
        parsed.data,
        await loadSavedNotificationConfig(authResult.userId),
        removed,
      );
    } catch (error) {
      if (error instanceof SecretHostChangedError) {
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      throw error;
    }

    const result = await testNotification(testConfig);

    return new Response(
      JSON.stringify(result),
      {
        status: result.success ? 200 : 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return createSecureErrorResponse(error, "notification test", 500);
  }
};
