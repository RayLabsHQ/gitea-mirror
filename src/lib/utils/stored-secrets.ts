/**
 * Saved tokens and secrets are write-only. The API says whether one is saved
 * (`hasToken`, `hasSecret`) and never sends it back, so nothing that can read
 * settings, a read-only API key included, can copy a token out.
 *
 * A saved token is also only sent to the origin it was saved for: the same
 * scheme, host and port. Otherwise anyone who can change settings could
 * point the address at a server of their own, another port on the same
 * machine, or plain http, and collect the token from the next request.
 * Moving to another address needs the token entered again.
 *
 * What a request sends for a secret:
 * - nothing or an empty string keeps the saved one,
 * - a new value replaces it,
 * - null removes it (notification secrets).
 */
import { decrypt, encrypt, isEncrypted } from "@/lib/utils/encryption";

/**
 * Origin (scheme, host and port) of an http(s) URL, with the host
 * lower-cased and a default port left out, or null when it does not parse.
 */
export function urlOrigin(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Whether a secret saved with `savedUrl` may be sent to `nextUrl`. */
export function sameOrigin(savedUrl: unknown, nextUrl: unknown): boolean {
  const saved = urlOrigin(savedUrl);
  return saved !== null && saved === urlOrigin(nextUrl);
}

/** A saved secret would have followed its address to another origin. */
export class SecretHostChangedError extends Error {
  constructor(label: string, savedUrl: unknown, nextUrl: unknown) {
    const to = urlOrigin(nextUrl);
    const from = urlOrigin(savedUrl);
    super(
      `Enter a ${label} for ${to ?? "the new address"}. ` +
        (from ? `The saved one is only sent to ${from}.` : "The saved one is not sent to a new address.")
    );
    this.name = "SecretHostChangedError";
  }
}

/** A string that holds more than whitespace. */
export function hasValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The encrypted value to store for one secret: the new one when the request
 * sent one, else the saved one, else empty. `bound` secrets are sent to an
 * address, so a saved one is only kept while that address keeps the same
 * origin; otherwise SecretHostChangedError is thrown.
 */
export function nextStoredSecret(options: {
  label: string;
  incoming: unknown;
  stored: string | null | undefined;
  bound: false;
} | {
  label: string;
  incoming: unknown;
  stored: string | null | undefined;
  bound: true;
  storedUrl: unknown;
  nextUrl: unknown;
}): string {
  if (hasValue(options.incoming)) return encrypt(options.incoming.trim());
  const stored = options.stored;
  if (!stored) return "";
  if (options.bound && !sameOrigin(options.storedUrl, options.nextUrl)) {
    throw new SecretHostChangedError(options.label, options.storedUrl, options.nextUrl);
  }
  // Rows written before encryption hold plain text; encrypt them on the way through.
  return isEncrypted(stored) ? stored : encrypt(stored);
}

/**
 * The decrypted saved secret a connection test may use in place of an empty
 * field, or null when there is none or the test points at another origin.
 */
export function savedSecretFor(
  stored: string | null | undefined,
  storedUrl: unknown,
  nextUrl: unknown
): string | null {
  if (!stored || !sameOrigin(storedUrl, nextUrl)) return null;
  const value = decrypt(stored);
  return value || null;
}

type NotificationSecretProvider = "ntfy" | "apprise" | "gotify" | "webhook";

const NOTIFICATION_SECRETS: ReadonlyArray<{
  provider: NotificationSecretProvider;
  field: "token" | "secret";
  flag: "hasToken" | "hasSecret";
  label: string;
  /** ntfy falls back to the public server when no URL is stored. */
  defaultUrl?: string;
  /** The webhook secret only signs the body and is never sent anywhere. */
  bound: boolean;
}> = [
  { provider: "ntfy", field: "token", flag: "hasToken", label: "ntfy access token", defaultUrl: "https://ntfy.sh", bound: true },
  { provider: "apprise", field: "token", flag: "hasToken", label: "Apprise token", bound: true },
  { provider: "gotify", field: "token", flag: "hasToken", label: "Gotify token", bound: true },
  { provider: "webhook", field: "secret", flag: "hasSecret", label: "webhook signing secret", bound: false },
];

type NotificationLike = Record<string, any> | null | undefined;

/**
 * A copy of a stored notification config for the browser: every secret
 * blanked, with `hasToken` or `hasSecret` saying whether one is saved.
 */
export function redactNotificationSecrets<T extends NotificationLike>(config: T): T {
  if (!config || typeof config !== "object") return config;
  const copy: Record<string, any> = { ...config };
  for (const { provider, field, flag } of NOTIFICATION_SECRETS) {
    const section = copy[provider];
    if (section && typeof section === "object") {
      copy[provider] = { ...section, [field]: "", [flag]: hasValue(section[field]) };
    }
  }
  return copy as T;
}

/**
 * Takes the secrets a request removes (sent as null) out of a raw
 * notification config, so the rest can be validated as usual.
 */
export function takeRemovedNotificationSecrets(raw: unknown): {
  config: unknown;
  removed: Set<NotificationSecretProvider>;
} {
  const removed = new Set<NotificationSecretProvider>();
  if (!raw || typeof raw !== "object") return { config: raw, removed };
  const copy: Record<string, any> = { ...(raw as Record<string, any>) };
  for (const { provider, field } of NOTIFICATION_SECRETS) {
    const section = copy[provider];
    if (section && typeof section === "object" && section[field] === null) {
      removed.add(provider);
      const { [field]: _removed, ...rest } = section;
      copy[provider] = rest;
    }
  }
  return { config: copy, removed };
}

/**
 * The notification config to store: new secrets encrypted, saved ones kept,
 * removed ones dropped. A provider section the request leaves out is dropped
 * with its secret, as before. Throws SecretHostChangedError.
 */
export function mergeNotificationSecrets<T extends Record<string, any>>(
  incoming: T,
  stored: NotificationLike,
  removed: ReadonlySet<NotificationSecretProvider> = new Set()
): T {
  const merged: Record<string, any> = { ...incoming };
  for (const { provider, field, label, defaultUrl, bound } of NOTIFICATION_SECRETS) {
    const section = merged[provider];
    if (!section || typeof section !== "object") continue;
    const savedSection = stored?.[provider];
    const value = removed.has(provider)
      ? ""
      : bound
        ? nextStoredSecret({
            label,
            incoming: section[field],
            stored: savedSection?.[field],
            bound: true,
            storedUrl: savedSection?.url || defaultUrl,
            nextUrl: section.url || defaultUrl,
          })
        : nextStoredSecret({ label, incoming: section[field], stored: savedSection?.[field], bound: false });
    merged[provider] = { ...section, [field]: value };
  }
  return merged as T;
}

/**
 * For a settings import (#587): drop each saved notification secret whose
 * address now points at another origin, where a save would refuse instead,
 * since the file never carries the secret and the user cannot type it into
 * an import. Returns the cleaned settings and the labels of the secrets that
 * were dropped, so the import can say which ones to enter again.
 */
export function dropMovedNotificationSecrets<T extends Record<string, any>>(
  next: T,
  stored: NotificationLike
): { config: T; dropped: string[] } {
  const config: Record<string, any> = { ...next };
  const dropped: string[] = [];
  for (const { provider, field, label, defaultUrl, bound } of NOTIFICATION_SECRETS) {
    if (!bound) continue;
    const section = config[provider];
    if (!section || typeof section !== "object" || !hasValue(section[field])) continue;
    const savedUrl = stored?.[provider]?.url || defaultUrl;
    const nextUrl = section.url || defaultUrl;
    if (savedUrl === nextUrl || sameOrigin(savedUrl, nextUrl)) continue;
    config[provider] = { ...section, [field]: "" };
    dropped.push(label);
  }
  return { config: config as T, dropped };
}

/**
 * A notification config for a test send of the selected provider: an empty
 * secret filled in with the saved one where allowed, decrypted. The other
 * providers' sections are left out. Throws SecretHostChangedError.
 */
export function withSavedNotificationSecrets<T extends Record<string, any>>(
  incoming: T,
  stored: NotificationLike,
  removed: ReadonlySet<NotificationSecretProvider> = new Set()
): T {
  const active = NOTIFICATION_SECRETS.find(({ provider }) => provider === incoming.provider);
  const only: Record<string, any> = { ...incoming };
  for (const { provider } of NOTIFICATION_SECRETS) {
    if (provider !== active?.provider) delete only[provider];
  }
  const merged: Record<string, any> = mergeNotificationSecrets(only, stored, removed);
  if (active) {
    const section = merged[active.provider];
    if (section && typeof section === "object" && section[active.field]) {
      merged[active.provider] = { ...section, [active.field]: decrypt(section[active.field]) };
    }
  }
  return merged as T;
}
