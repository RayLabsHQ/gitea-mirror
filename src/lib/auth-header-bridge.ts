import { auth } from "./auth";

export interface BridgeResult {
  user: any;
  session: any;
  setCookies: string[];
}

/**
 * Calls the `header-auth` plugin endpoint to mint a real Better Auth
 * session from trusted upstream headers (Authentik / Authelia /
 * oauth2-proxy / Caddy), and returns the user, session, and the
 * `Set-Cookie` headers for the middleware to forward onto the
 * outbound response.
 *
 * Fail-open: returns null on any failure (endpoint disabled, headers
 * missing, DB blip, malformed response). The middleware then sets
 * locals to null and the request proceeds as anonymous — broken
 * header auth must never lock everyone out of the cookie-auth path.
 *
 * Cookie extraction prefers `Response.headers.getSetCookie()` (Node 18+
 * fetch, undici). Older runtimes that only expose `get('set-cookie')`
 * fall through to the single-header form; that path coalesces all
 * Set-Cookie values into one comma-separated string, which is wrong
 * for cookies whose attributes contain commas (`Expires` does). We
 * accept that risk because: (a) Bun and the supported Node versions
 * for this project both implement `getSetCookie`, and (b) the
 * fallback only fires on truly ancient runtimes that aren't in our
 * support matrix.
 */
export async function mintSessionFromHeaders(
  request: Request,
): Promise<BridgeResult | null> {
  try {
    const response = await auth.api.signInWithHeader({
      headers: request.headers,
      asResponse: true,
    });

    if (!response.ok) return null;

    const data = await response.json().catch(() => null);
    if (!data?.user || !data?.session) return null;

    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie") as string]
          : [];

    return { user: data.user, session: data.session, setCookies };
  } catch {
    return null;
  }
}
