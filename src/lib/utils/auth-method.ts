/**
 * Login method selection: which tab the login page opens on.
 *
 * Three inputs decide it:
 * - The method this browser last signed in with (localStorage, per browser).
 * - The server default from the AUTH_DEFAULT_METHOD environment variable,
 *   served by GET /api/auth/methods.
 * - Which methods the instance actually offers right now.
 *
 * The parsing and resolution helpers are pure so they can run on the server
 * (the API route) and in tests; only the storage helpers touch the browser.
 */

export type AuthMethod = "email" | "sso";

/** Used whenever nothing else applies, and for an unrecognised env value. */
export const DEFAULT_AUTH_METHOD: AuthMethod = "email";

export const LAST_AUTH_METHOD_STORAGE_KEY = "lastAuthMethod";

export function isAuthMethod(value: unknown): value is AuthMethod {
  return value === "email" || value === "sso";
}

/**
 * Read AUTH_DEFAULT_METHOD (or any other source). Anything that is not
 * "email" or "sso", case and whitespace insensitive, falls back to "email".
 */
export function parseDefaultAuthMethod(value: unknown): AuthMethod {
  if (typeof value !== "string") return DEFAULT_AUTH_METHOD;
  const normalized = value.trim().toLowerCase();
  return isAuthMethod(normalized) ? normalized : DEFAULT_AUTH_METHOD;
}

export interface AvailableAuthMethods {
  email: boolean;
  sso: boolean;
}

export interface ResolveInitialAuthMethodInput {
  /** What this browser used last, or null when nothing is stored. */
  remembered?: AuthMethod | null;
  /** The instance default from the server. */
  serverDefault?: AuthMethod;
  available: AvailableAuthMethods;
}

/**
 * Pick the method the login page opens on: the remembered one if it is still
 * available, else the server default if it is available, else email, else SSO.
 */
export function resolveInitialAuthMethod({
  remembered,
  serverDefault = DEFAULT_AUTH_METHOD,
  available,
}: ResolveInitialAuthMethodInput): AuthMethod {
  if (remembered && available[remembered]) return remembered;
  if (available[serverDefault]) return serverDefault;
  if (available.email) return "email";
  return "sso";
}

/**
 * Read the method this browser last signed in with. Safe during SSR and when
 * storage is unavailable (private window, blocked site data): returns null.
 */
export function getLastAuthMethod(): AuthMethod | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(LAST_AUTH_METHOD_STORAGE_KEY);
    return isAuthMethod(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Remember the method that was just used. Best effort, never throws. */
export function setLastAuthMethod(method: AuthMethod): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LAST_AUTH_METHOD_STORAGE_KEY, method);
  } catch {
    // Storage disabled or full; the login page just falls back to the default.
  }
}
