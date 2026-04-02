import { useEffect, useState, useRef, useCallback } from "react";
import type { MirrorJob } from "@/lib/db/schema";
import { withBase } from "@/lib/base-path";

interface UseSSEOptions {
  userId?: string;
  onMessage: (data: MirrorJob) => void;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
}

export const useSSE = ({
  userId,
  onMessage,
  maxReconnectAttempts = 5,
  reconnectDelay = 3000
}: UseSSEOptions) => {
  const [connected, setConnected] = useState<boolean>(false);
  const [reconnectCount, setReconnectCount] = useState<number>(0);
  const onMessageRef = useRef(onMessage);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  // Update the ref when onMessage changes
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  // Create a stable connect function that can be called for reconnection
  const connect = useCallback(() => {
    if (!userId) return;

    // Clean up any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Clear any pending reconnect timeout
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Create new EventSource connection
    const eventSource = new EventSource(`${withBase("/api/sse")}?userId=${userId}`);
    eventSourceRef.current = eventSource;

    const handleMessage = (event: MessageEvent) => {
      try {
        // Check if this is an error message from our server
        if (event.data.startsWith('{"error":')) {
          console.warn("SSE server error:", event.data);
          return;
        }

        const parsedMessage: MirrorJob = JSON.parse(event.data);
        onMessageRef.current(parsedMessage);
      } catch (error) {
        console.error("Error parsing SSE message:", error);
      }
    };

    eventSource.onmessage = handleMessage;

    eventSource.onopen = () => {
      setConnected(true);
      setReconnectCount(0); // Reset reconnect counter on successful connection
    };

    eventSource.onerror = (error) => {
      console.error("SSE connection error:", error);
      setConnected(false);
      eventSource.close();
      eventSourceRef.current = null;

      // Attempt to reconnect if we haven't exceeded max attempts
      if (reconnectCount < maxReconnectAttempts) {
        const nextReconnectDelay = Math.min(reconnectDelay * Math.pow(1.5, reconnectCount), 30000);
        console.log(`Attempting to reconnect in ${nextReconnectDelay}ms (attempt ${reconnectCount + 1}/${maxReconnectAttempts})`);

        reconnectTimeoutRef.current = window.setTimeout(() => {
          setReconnectCount(prev => prev + 1);
          connect();
        }, nextReconnectDelay);
      } else {
        console.error(`Failed to reconnect after ${maxReconnectAttempts} attempts`);
      }
    };
  }, [userId, maxReconnectAttempts, reconnectDelay, reconnectCount]);

  // Set up the connection
  useEffect(() => {
    if (!userId) return;

    connect();

    // Cleanup function
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [userId, connect]);

  return { connected };
};
