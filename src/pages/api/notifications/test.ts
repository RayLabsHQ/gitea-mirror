import type { APIRoute } from "astro";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { testNotification } from "@/lib/notification-service";
import { createSecureErrorResponse } from "@/lib/utils";

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

    const result = await testNotification(notificationConfig);

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
