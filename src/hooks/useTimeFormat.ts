import { useCallback, useSyncExternalStore } from "react";
import {
  getTimeFormatPreference,
  setTimeFormatPreference,
  subscribeToTimeFormatChange,
  type TimeFormatPreference,
} from "@/lib/utils/time-format";

const getServerSnapshot = (): TimeFormatPreference => "auto";

/**
 * Subscribe a component to the user's 12h/24h time format preference.
 *
 * Any component that renders clock times should call this hook (even if it
 * only needs the re-render) so timestamps update immediately when the user
 * changes the preference — navigation is SPA-style, so components stay
 * mounted across pages.
 */
export function useTimeFormat() {
  const preference = useSyncExternalStore(
    subscribeToTimeFormatChange,
    getTimeFormatPreference,
    getServerSnapshot
  );

  const setPreference = useCallback((next: TimeFormatPreference) => {
    setTimeFormatPreference(next);
  }, []);

  return { preference, setPreference };
}
