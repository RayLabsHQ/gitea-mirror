/**
 * Shared constants and helpers for API keys (issue #314).
 *
 * Dependency free so React components can import it. The Better Auth
 * plugin wiring lives in auth.ts (server) and auth-client.ts (browser).
 */

/** Every key starts with this so it is recognisable in logs and scanners. */
export const API_KEY_PREFIX = "gm_";

/** Request header that carries a key. */
export const API_KEY_HEADER = "x-api-key";

/** Length of the random part. The session hook rejects anything shorter. */
export const API_KEY_LENGTH = 64;

/** Characters kept in the database for display, prefix included. */
export const API_KEY_START_LENGTH = 10;

/** Name length limit enforced by the plugin. */
export const API_KEY_NAME_MAX_LENGTH = 32;

export type ApiKeyExpiryOption = "never" | "30d" | "90d" | "1y";

const DAY_SECONDS = 60 * 60 * 24;

export const API_KEY_EXPIRY_OPTIONS: ReadonlyArray<{
  value: ApiKeyExpiryOption;
  label: string;
  seconds: number | null;
}> = [
  { value: "never", label: "Never", seconds: null },
  { value: "30d", label: "30 days", seconds: 30 * DAY_SECONDS },
  { value: "90d", label: "90 days", seconds: 90 * DAY_SECONDS },
  { value: "1y", label: "1 year", seconds: 365 * DAY_SECONDS },
];

/** Seconds for the create call, or undefined for a key that never expires. */
export function expiryOptionToSeconds(option: ApiKeyExpiryOption): number | undefined {
  const match = API_KEY_EXPIRY_OPTIONS.find((candidate) => candidate.value === option);
  return match?.seconds ?? undefined;
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True once the expiry date has passed. A key without one never expires. */
export function isKeyExpired(
  expiresAt: Date | string | number | null | undefined,
  now: Date = new Date()
): boolean {
  const date = toDate(expiresAt);
  return date !== null && date.getTime() <= now.getTime();
}

/** Wording for an expiry date relative to now. */
export function describeKeyExpiry(
  expiresAt: Date | string | number | null | undefined,
  now: Date = new Date()
): string {
  if (expiresAt == null) return "Never";
  const date = toDate(expiresAt);
  if (!date) return "Unknown";
  const diffMs = date.getTime() - now.getTime();
  if (diffMs <= 0) return "Expired";
  const days = Math.ceil(diffMs / (DAY_SECONDS * 1000));
  if (days <= 1) return "Within a day";
  return `In ${days} days`;
}

/** Display form of a key: the stored starting characters and a mask. */
export function maskKeyStart(start: string | null | undefined): string {
  const shown = start && start.trim() ? start.trim() : API_KEY_PREFIX;
  return `${shown}${"•".repeat(8)}`;
}

/** Trim a proposed key name and report whether the plugin will accept it. */
export function normalizeKeyName(name: string): { value: string; error: string | null } {
  const value = name.trim();
  if (!value) return { value, error: "Give the key a name so you can tell it apart later." };
  if (value.length > API_KEY_NAME_MAX_LENGTH) {
    return { value, error: `Keep the name to ${API_KEY_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { value, error: null };
}
