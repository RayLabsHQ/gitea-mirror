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
 * New accounts through SSO follow a related rule (see ssoSignupAllowed):
 * once an account exists, an SSO sign-in only creates a new account when
 * the email belongs to the provider's Email Domain, unless
 * AUTH_ALLOW_SIGNUP=true. Without it, registering a provider such as
 * Google let anyone with an account there in.
 *
 * Header auth provisioning (HEADER_AUTH_AUTO_PROVISION) is separate and not
 * affected: it has its own opt-in and domain allowlist.
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

/**
 * True for the SSO plugin's endpoints. Users are only created on its
 * callback paths (/sso/callback/:providerId, /sso/saml2/sp/acs/:providerId,
 * and the shared /sso/callback).
 */
export function isSsoPath(path: string | undefined): boolean {
  return typeof path === "string" && path.startsWith("/sso/");
}

/**
 * True when the email's domain is one of the provider's domains or a
 * subdomain of one. The Domain field takes a comma separated list. Matches
 * the SSO plugin's own check for account linking.
 */
export function emailMatchesProviderDomain(
  email: string | null | undefined,
  domainList: string | null | undefined,
): boolean {
  if (typeof email !== "string" || typeof domainList !== "string") return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const emailDomain = email.slice(at + 1).trim().toLowerCase();
  if (!emailDomain) return false;
  return domainList
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`));
}

/**
 * Whether an SSO sign-in may create a new account. The first account is
 * always allowed, AUTH_ALLOW_SIGNUP=true allows any, and otherwise the
 * email must belong to the provider's domain. An unknown provider
 * (domain null) is refused.
 */
export function ssoSignupAllowed({
  userCount,
  allowSignup,
  email,
  providerDomain,
}: {
  userCount: number;
  allowSignup: boolean;
  email: string | null | undefined;
  providerDomain: string | null;
}): boolean {
  if (!isSignupClosed({ userCount, allowSignup })) return true;
  return emailMatchesProviderDomain(email, providerDomain);
}

export function ssoSignupClosedError(): APIError {
  return new APIError("FORBIDDEN", {
    message:
      "No account exists for this email, and its domain is not the provider's Email Domain. Ask the admin to add the domain to the provider or set AUTH_ALLOW_SIGNUP=true.",
    code: "SIGNUP_CLOSED",
  });
}

type SignupGuardOptions = {
  countUsers: () => Promise<number>;
  /** The Domain field of an SSO provider, or null when there is no such provider. */
  findSsoProviderDomain: (providerId: string) => Promise<string | null>;
};

/**
 * Runs before Better Auth writes a new user. Refuses the write when it comes
 * from an SSO endpoint and ssoSignupAllowed says no. Checking here instead of
 * with the plugin's disableImplicitSignUp matters: that option can be
 * overridden by the client, which may send requestSignUp with the sign-in.
 */
export function createSsoSignupCheck(options: SignupGuardOptions) {
  return async (
    user: { email?: string | null },
    ctx: { path?: string; params?: Record<string, unknown> } | null | undefined,
  ): Promise<void> => {
    if (!isSsoPath(ctx?.path)) return;
    if (isOpenRegistration()) return;
    const userCount = await options.countUsers();
    if (!isSignupClosed({ userCount, allowSignup: false })) return;
    const providerId = typeof ctx?.params?.providerId === "string" ? ctx.params.providerId : null;
    const providerDomain = providerId ? await options.findSsoProviderDomain(providerId) : null;
    if (!ssoSignupAllowed({ userCount, allowSignup: false, email: user.email, providerDomain })) {
      throw ssoSignupClosedError();
    }
  };
}

export const signupGuardPlugin = (options: SignupGuardOptions) =>
  ({
    id: "signup-guard",
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              before: createSsoSignupCheck(options),
            },
          },
        },
      },
    }),
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
