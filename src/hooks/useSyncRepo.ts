import { useEffect, useRef } from "react";
import { useAuth } from "./useAuth";
import { withBase } from "@/lib/base-path";

interface UseRepoSyncOptions {
  userId?: string;
  enabled?: boolean;
  interval?: number;
  lastSync?: Date | null;
  nextSync?: Date | null;
}

export function useRepoSync({
  userId,
  enabled = true,
  interval = 3600,
  lastSync,
  nextSync,
}: UseRepoSyncOptions) {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const { refreshUser } = useAuth();

  useEffect(() => {
    if (!enabled || !userId) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Helper to convert possible nextSync types to Date
    const getNextSyncDate = () => {
      if (!nextSync) return null;
      if (nextSync instanceof Date) return nextSync;
      return new Date(nextSync); // Handles strings and numbers
    };

    const getLastSyncDate = () => {
      if (!lastSync) return null;
      if (lastSync instanceof Date) return lastSync;
      return new Date(lastSync);
    };

    const isTimeToSync = () => {
      const nextSyncDate = getNextSyncDate();
      if (!nextSyncDate) return true; // No nextSync means sync immediately

      const currentTime = new Date();
      return currentTime >= nextSyncDate;
    };

    const sync = async () => {
      try {
        const response = await fetch(withBase("/api/job/schedule-sync-repo"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId }),
        });

        if (!response.ok) {
          console.error("Sync failed:", await response.text());
          return;
        }

        await refreshUser(); // refresh user data to get latest sync times. this can be taken from the schedule-sync-repo response but might not be reliable in cases of errors

        const result = await response.json();
        return result;
      } catch (error) {
        console.error("Sync failed:", error);
      }
    };

    // Check if sync is overdue when the component mounts or interval passes
    if (isTimeToSync()) {
      sync();
    }

    // Periodically check if it's time to sync
    intervalRef.current = setInterval(() => {
      if (isTimeToSync()) {
        sync();
      }
    }, interval * 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [
    enabled,
    interval,
    userId,
    nextSync instanceof Date ? nextSync.getTime() : nextSync,
    lastSync instanceof Date ? lastSync.getTime() : lastSync,
  ]);
}
