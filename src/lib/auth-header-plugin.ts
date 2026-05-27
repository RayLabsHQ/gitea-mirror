import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { authenticateWithHeaders, isHeaderAuthEnabled } from "./auth-header";

/**
 * Better Auth plugin that bridges header / forward authentication into a
 * real Better Auth session.
 *
 * Why this exists: the Astro middleware historically populated
 * `context.locals.user` from trusted upstream headers (Authentik /
 * Authelia / oauth2-proxy / Caddy), but never minted a Better Auth
 * session. Server-rendered pages saw the user, but the React SPA's
 * `/api/auth/get-session` call hit Better Auth's handler — which only
 * reads its session cookie — and got `null`. The auth guard then
 * bounced to `/login`, so header auth was end-to-end broken.
 *
 * This plugin exposes `POST /sign-in/header`, which the middleware
 * calls once per cold request (no cookie yet) when header auth is
 * enabled. It verifies the trusted headers, creates a real session
 * row via `internalAdapter.createSession`, and attaches the
 * `Set-Cookie` to the response. The middleware then forwards that
 * cookie to the outbound Astro response, so the SPA's next call to
 * `get-session` carries the cookie and works.
 *
 * The endpoint trusts whatever upstream sets the configured headers —
 * the security model here is "the operator controls the reverse
 * proxy." Make sure the proxy strips inbound copies of these headers
 * before forwarding (documented in docs/SSO-OIDC-SETUP.md).
 */
export const headerAuthPlugin = () =>
  ({
    id: "header-auth",
    endpoints: {
      signInWithHeader: createAuthEndpoint(
        "/sign-in/header",
        { method: "POST" },
        async (ctx) => {
          if (!isHeaderAuthEnabled()) {
            throw new APIError("NOT_FOUND", {
              message: "Header authentication is not enabled",
            });
          }

          const headers = ctx.request?.headers ?? ctx.headers;
          if (!headers) {
            throw new APIError("BAD_REQUEST", {
              message: "Request headers unavailable",
            });
          }

          const user = await authenticateWithHeaders(headers);
          if (!user) {
            throw new APIError("UNAUTHORIZED", {
              message: "Header authentication failed",
            });
          }

          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Failed to create session",
            });
          }

          await setSessionCookie(ctx, { session, user });

          return ctx.json({
            token: session.token,
            user,
            session,
          });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
