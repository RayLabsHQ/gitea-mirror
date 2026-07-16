/**
 * Shared time/date formatting with a user-configurable 12h/24h preference.
 *
 * All timestamp rendering in the UI should go through this module so that:
 * - By default ("auto") times follow the browser locale's convention instead
 *   of a hardcoded locale (previously "en-US" forced 12-hour AM/PM for everyone).
 * - Users can explicitly force 12-hour or 24-hour time. The preference is a
 *   pure display concern, so it is persisted client-side in localStorage
 *   (same mechanism as the theme preference) rather than in the database.
 */

export type TimeFormatPreference = "auto" | "12h" | "24h";

export const TIME_FORMAT_STORAGE_KEY = "timeFormat";
export const TIME_FORMAT_CHANGE_EVENT = "gitea-mirror:time-format-change";

export function isTimeFormatPreference(
  value: unknown
): value is TimeFormatPreference {
  return value === "auto" || value === "12h" || value === "24h";
}

/**
 * Read the persisted preference. Safe to call during SSR / in tests where
 * localStorage does not exist (falls back to "auto").
 */
export function getTimeFormatPreference(): TimeFormatPreference {
  if (typeof localStorage === "undefined") return "auto";
  try {
    const stored = localStorage.getItem(TIME_FORMAT_STORAGE_KEY);
    return isTimeFormatPreference(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

/**
 * Persist the preference and notify listeners in this tab. Other tabs are
 * notified via the native "storage" event.
 */
export function setTimeFormatPreference(preference: TimeFormatPreference): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(TIME_FORMAT_STORAGE_KEY, preference);
    }
  } catch {
    // Persisting is best-effort (e.g. storage disabled); still notify listeners.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(TIME_FORMAT_CHANGE_EVENT, { detail: preference })
    );
  }
}

/**
 * Subscribe to preference changes (same tab via custom event, other tabs via
 * the "storage" event). Returns an unsubscribe function. Compatible with
 * React's useSyncExternalStore.
 */
export function subscribeToTimeFormatChange(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (event.key === TIME_FORMAT_STORAGE_KEY) callback();
  };
  window.addEventListener(TIME_FORMAT_CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TIME_FORMAT_CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** Map a preference onto Intl's hour12 option ("auto" defers to the locale). */
export function resolveHour12(
  preference: TimeFormatPreference
): boolean | undefined {
  if (preference === "12h") return true;
  if (preference === "24h") return false;
  return undefined;
}

export interface FormatDateTimeOptions {
  /** Override the stored preference (mainly for tests). */
  preference?: TimeFormatPreference;
  /** Override the browser/system locale (mainly for tests). */
  locale?: string;
}

function buildOptions(
  base: Intl.DateTimeFormatOptions,
  preference: TimeFormatPreference
): Intl.DateTimeFormatOptions {
  const hour12 = resolveHour12(preference);
  return hour12 === undefined ? base : { ...base, hour12 };
}

/**
 * Full date + time, e.g. "January 15, 2023, 12:30 PM" / "15. Januar 2023, 12:30".
 * Locale defaults to the browser locale; hour cycle follows the user preference.
 */
export function formatDateTime(
  date: Date | string | number,
  options: FormatDateTimeOptions = {}
): string {
  const preference = options.preference ?? getTimeFormatPreference();
  return new Intl.DateTimeFormat(
    options.locale,
    buildOptions(
      {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      },
      preference
    )
  ).format(new Date(date));
}

/**
 * Compact date + time, e.g. "01/15/23, 12:30 PM" / "15.01.23, 12:30".
 * Used where space is tight (dashboard status cards).
 */
export function formatShortDateTime(
  date: Date | string | number,
  options: FormatDateTimeOptions = {}
): string {
  const preference = options.preference ?? getTimeFormatPreference();
  return new Intl.DateTimeFormat(
    options.locale,
    buildOptions(
      {
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      },
      preference
    )
  ).format(new Date(date));
}

/**
 * Time only, e.g. "12:30 PM" / "12:30".
 */
export function formatTime(
  date: Date | string | number,
  options: FormatDateTimeOptions = {}
): string {
  const preference = options.preference ?? getTimeFormatPreference();
  return new Intl.DateTimeFormat(
    options.locale,
    buildOptions({ hour: "2-digit", minute: "2-digit" }, preference)
  ).format(new Date(date));
}
