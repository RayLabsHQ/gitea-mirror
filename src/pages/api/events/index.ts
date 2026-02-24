import type { APIRoute } from "astro";
import { getNewEvents } from "@/lib/events";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAuthenticatedUserId({ request, locals });
  if ("response" in authResult) return authResult.response;
  const userId = authResult.userId;

  // Create a new ReadableStream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let lastEventTime = new Date();

      // Send initial connection message
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Poll for new events every 2 seconds
      const pollInterval = setInterval(async () => {
        try {
          // Get new rate limit events
          const newEvents = await getNewEvents({
            userId,
            channel: "rate-limit",
            lastEventTime,
          });

          // Send each new event
          for (const event of newEvents) {
            const message = `event: rate-limit\ndata: ${JSON.stringify(event.payload)}\n\n`;
            controller.enqueue(encoder.encode(message));
            lastEventTime = new Date(event.createdAt);
          }
        } catch (error) {
          console.error("Error polling for events:", error);
        }
      }, 2000); // Poll every 2 seconds

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch (error) {
          clearInterval(heartbeatInterval);
          clearInterval(pollInterval);
        }
      }, 30000);

      // Cleanup on close
      request.signal.addEventListener("abort", () => {
        clearInterval(pollInterval);
        clearInterval(heartbeatInterval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
};
