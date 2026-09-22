import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * Closes email and password sign-up once the first account exists.
 *
 * The signup page already redirects to the login page when a user exists,
 * but that check lived only in the page. The Better Auth endpoint behind
 * it, POST /api/auth/sign-up/email, accepted new accounts from anyone who
 * could reach the instance, which turned every "signed in users only" API
 * route into a public one. This plugin refuses the endpoint server side
 * once a user exists, unless the operator opts into open registration with
 * AUTH_ALLOW_SIGNUP=true.
 *
 * SSO sign-ins through a registered identity provider and header auth
 * provisioning (HEADER_AUTH_AUTO_PROVISION) are separate flows and are not
 * affected: the operator chose those providers.
 */

/** Endpoint path (without the auth base path) of email sign-up. */
export const SIGNUP_PATH = "/sign-up/email";

export function isSignupRequest(path: string | undefined): boolean {
  return path === SIGNUP_PATH;
}

/** Reads the opt-in from the environment: only the literal "true" opens sign-up. */
export function isOpenRegistration(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_ALLOW_SIGNUP === "true";
}

/** True when a sign-up must be refused: an account exists and registration is closed. */
export function isSignupClosed({
  userCount,
  allowSignup,
}: {
  userCount: number;
  allowSignup: boolean;
}): boolean {
  return userCount > 0 && !allowSignup;
}

export function signupClosedError(): APIError {
  return new APIError("FORBIDDEN", {
    message:
      "Sign-up is closed: an account already exists on this instance. Set AUTH_ALLOW_SIGNUP=true to allow more accounts.",
    code: "SIGNUP_CLOSED",
  });
}

export const signupGuardPlugin = (options: { countUsers: () => Promise<number> }) =>
  ({
    id: "signup-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => isSignupRequest(ctx.path),
          handler: createAuthMiddleware(async () => {
            if (isOpenRegistration()) return;
            const userCount = await options.countUsers();
            if (isSignupClosed({ userCount, allowSignup: false })) {
              throw signupClosedError();
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
