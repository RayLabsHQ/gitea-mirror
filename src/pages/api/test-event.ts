import type { APIRoute } from "astro";
import { publishEvent } from "@/lib/events";
import { v4 as uuidv4 } from "uuid";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = await request.json();
    const { message, status } = body;

    if (!message || !status) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: message, status",
        }),
        { status: 400 }
      );
    }

    // Create a test event
    const eventData = {
      id: uuidv4(),
      userId,
      repositoryId: uuidv4(),
      repositoryName: "test-repo",
      message,
      status,
      timestamp: new Date(),
    };

    // Publish the event
    const channel = `mirror-status:${userId}`;
    await publishEvent({
      userId,
      channel,
      payload: eventData,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Event published successfully",
        event: eventData,
      }),
      { status: 200 }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "test-event API", 500);
  }
};
