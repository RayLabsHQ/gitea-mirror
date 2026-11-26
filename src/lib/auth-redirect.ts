/**
 * Some auth answers tell the browser to go somewhere else: when an app signs
 * in through Gitea Mirror as an OIDC provider, a successful login answers with
 * `{ redirect: true, url }` for the app's callback or the consent page, and
 * Better Auth's client navigates there by itself. The login form must not
 * then send the browser to the dashboard, or a slow page loses the race.
 */
export interface AuthRedirectData {
  redirect?: boolean;
  url?: string;
  twoFactorRedirect?: boolean;
}

// The schemes Better Auth's redirect plugin refuses to follow.
const REFUSED_SCHEMES = ["javascript:", "data:", "vbscript:"];

/** True when Better Auth's client is already navigating for this answer. */
export function isAuthRedirect(data: AuthRedirectData | null | undefined): boolean {
  if (data?.redirect !== true || typeof data.url !== "string" || !data.url) return false;
  try {
    return !REFUSED_SCHEMES.includes(new URL(data.url).protocol);
  } catch {
    // A relative URL, which the plugin follows.
    return true;
  }
}
