import type { APIRoute } from "astro";
import { getNewEvents } from "@/lib/events";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAuthenticatedUserId({ request, locals });
  if ("response" in authResult) return authResult.response;
  const userId = authResult.userId;

  const channel = `mirror-status:${userId}`;
  let isClosed = false;
  const POLL_INTERVAL = 5000; // Poll every 5 seconds (reduced from 2 seconds for low-traffic usage)

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let lastEventTime: Date | undefined = undefined;
      let pollIntervalId: ReturnType<typeof setInterval> | null = null;

      // Function to send a message to the client
      const sendMessage = (message: string) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(message));
        } catch (err) {
          console.error("Stream enqueue error:", err);
        }
      };

      // Function to poll for new events
      const pollForEvents = async () => {
        if (isClosed) return;

        try {
          // Get new events from SQLite
          const events = await getNewEvents({
            userId,
            channel,
            lastEventTime,
          });

          // Send events to client
          if (events.length > 0) {
            // Update last event time
            lastEventTime = events[events.length - 1].createdAt;

            // Send each event to the client
            for (const event of events) {
              sendMessage(`data: ${JSON.stringify(event.payload)}\n\n`);
            }
          }
        } catch (err) {
          console.error("Error polling for events:", err);
          sendMessage(`data: {"error": "Error polling for events"}\n\n`);
        }
      };

      // Send initial connection message
      sendMessage(": connected\n\n");

      // Start polling for events
      pollForEvents();

      // Set up polling interval
      pollIntervalId = setInterval(pollForEvents, POLL_INTERVAL);

      // Send a heartbeat every 30 seconds to keep the connection alive
      const heartbeatInterval = setInterval(() => {
        if (!isClosed) {
          sendMessage(": heartbeat\n\n");
        } else {
          clearInterval(heartbeatInterval);
        }
      }, 30000);

      // Handle client disconnection
      request.signal?.addEventListener("abort", () => {
        if (!isClosed) {
          isClosed = true;
          if (pollIntervalId) {
            clearInterval(pollIntervalId);
          }
          controller.close();
        }
      });
    },
    cancel() {
      // Extra safety in case cancel is triggered
      isClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
};
