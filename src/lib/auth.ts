import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { db, users, ssoProviders } from "./db";
import * as schema from "./db/schema";
import { eq } from "drizzle-orm";
import { withBase } from "./base-path";
import { headerAuthPlugin } from "./auth-header-plugin";

/**
 * Extracts the origins implied by registered SSO identity providers.
 *
 * The SSO plugin (since better-auth 1.6.23, shipped in v3.21.0) hardens
 * sign-in against SSRF: it refuses to fetch OIDC discovery documents from
 * untrusted origins and rejects token/userinfo/jwks endpoints whose
 * hostnames resolve to private addresses — unless the origin is listed in
 * `trustedOrigins`, the documented escape hatch for internal IdPs. Homelab
 * deployments with split-horizon DNS (auth.example.com resolving to a LAN
 * IP from inside the container) hit this on every sign-in, which the login
 * UI used to swallow silently (#366).
 *
 * Registering a provider is an explicit operator action — the same trust
 * model behind the `domainVerified` flag we set at registration — so the
 * provider's issuer and endpoint origins are trusted automatically instead
 * of requiring BETTER_AUTH_TRUSTED_ORIGINS to be set by hand. Note this
 * also lets those origins pass Better Auth's CSRF/redirect-target checks,
 * which is acceptable for operator-registered IdP infrastructure.
 *
 * Exported for testing.
 */
export function extractSsoProviderOrigins(
  rows: Array<{ issuer?: string | null; oidcConfig?: string | null }>
): string[] {
  const origins: string[] = [];
  for (const row of rows) {
    const candidates: unknown[] = [row?.issuer];
    if (typeof row?.oidcConfig === "string" && row.oidcConfig.trim() !== "") {
      try {
        const cfg = JSON.parse(row.oidcConfig);
        candidates.push(
          cfg?.discoveryEndpoint,
          cfg?.authorizationEndpoint,
          cfg?.tokenEndpoint,
          cfg?.userInfoEndpoint,
          cfg?.jwksEndpoint,
        );
      } catch {
        // A malformed provider row must not break auth for everyone;
        // the issuer candidate above still applies.
      }
    }
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || candidate.trim() === "") continue;
      try {
        const url = new URL(candidate);
        // Only http(s) URLs have a meaningful origin — new URL() accepts
        // values like SAML entity IDs ("urn:...") without throwing, but
        // their .origin is the literal string "null".
        if (url.protocol === "http:" || url.protocol === "https:") {
          origins.push(url.origin);
        }
      } catch {
        // Skip values that aren't URLs at all.
      }
    }
  }
  return origins;
}

/**
 * Resolves the list of trusted origins for Better Auth CSRF validation.
 * Exported for testing. Called per-request with the incoming Request,
 * or at startup with no request (static origins only).
 */
export async function resolveTrustedOrigins(request?: Request): Promise<string[]> {
  const origins: string[] = [
    "http://localhost:4321",
    "http://localhost:8080", // Keycloak
  ];

  // Add the primary URL from BETTER_AUTH_URL
  const primaryUrl = process.env.BETTER_AUTH_URL;
  if (primaryUrl && typeof primaryUrl === 'string' && primaryUrl.trim() !== '') {
    try {
      const validatedUrl = new URL(primaryUrl.trim());
      origins.push(validatedUrl.origin);
    } catch {
      // Skip if invalid
    }
  }

  // Add additional trusted origins from environment
  if (process.env.BETTER_AUTH_TRUSTED_ORIGINS) {
    const additionalOrigins = process.env.BETTER_AUTH_TRUSTED_ORIGINS
      .split(',')
      .map(o => o.trim())
      .filter(o => o !== '');

    for (const origin of additionalOrigins) {
      try {
        const validatedUrl = new URL(origin);
        origins.push(validatedUrl.origin);
      } catch {
        console.warn(`Invalid trusted origin: ${origin}, skipping`);
      }
    }
  }

  // Trust the origins of operator-registered SSO identity providers so the
  // SSO plugin's SSRF checks accept them without manual env configuration.
  // See extractSsoProviderOrigins for the rationale.
  try {
    const providerRows = await db
      .select({ issuer: ssoProviders.issuer, oidcConfig: ssoProviders.oidcConfig })
      .from(ssoProviders);
    if (Array.isArray(providerRows)) {
      origins.push(...extractSsoProviderOrigins(providerRows));
    }
  } catch {
    // Fresh DB before migration or DB briefly unavailable — fall back to
    // env-configured origins rather than failing auth outright.
  }

  // Auto-detect origin from the incoming request's Host header when running
  // behind a reverse proxy. Helps with Better Auth's per-request CSRF check.
  if (request?.headers) {
    // Take first value only — headers can be comma-separated in chained proxy setups
    const rawHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
    const host = rawHost?.split(",")[0].trim();
    if (host) {
      const rawProto = request.headers.get("x-forwarded-proto") || "http";
      const proto = rawProto.split(",")[0].trim().toLowerCase();
      if (proto === "http" || proto === "https") {
        try {
          const detected = new URL(`${proto}://${host}`);
          origins.push(detected.origin);
        } catch {
          // Malformed header, ignore
        }
      }
    }
  }

  const uniqueOrigins = [...new Set(origins.filter(Boolean))];
  if (!request) {
    console.info("Trusted origins (static):", uniqueOrigins);
  }
  return uniqueOrigins;
}

/**
 * Resolves the Better Auth logger level from BETTER_AUTH_LOG_LEVEL.
 * Returns undefined for unset/invalid values so Better Auth falls back
 * to its built-in default ("warn"). "success" is intentionally excluded
 * — it is an output level, not a valid threshold.
 */
function resolveAuthLogLevel(): "debug" | "info" | "warn" | "error" | undefined {
  const raw = process.env.BETTER_AUTH_LOG_LEVEL?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  if (raw) {
    console.warn(`Invalid BETTER_AUTH_LOG_LEVEL: "${raw}", using default ("warn")`);
  }
  return undefined;
}

export const auth = betterAuth({
  // Database configuration
  database: drizzleAdapter(db, {
    provider: "sqlite",
    usePlural: true, // Our tables use plural names (users, not user)
    schema, // Pass the schema explicitly
  }),

  // Secret for signing tokens
  secret: process.env.BETTER_AUTH_SECRET,

  // Logger configuration.
  //
  // Better Auth ships its own logger (it does NOT read the `DEBUG` env
  // var / the `debug` npm package — `DEBUG=better-auth:*` is a no-op).
  // The default level is "warn", so SSO/OIDC debug and info messages
  // are hidden out of the box. Set BETTER_AUTH_LOG_LEVEL=debug to surface
  // the full sign-in / callback trace when troubleshooting SSO.
  logger: {
    level: resolveAuthLogLevel(),
  },

  // Base URL configuration - use the primary URL (Better Auth only supports single baseURL)
  baseURL: (() => {
    const url = process.env.BETTER_AUTH_URL;
    const defaultUrl = "http://localhost:4321";
    
    // Check if URL is provided and not empty
    if (!url || typeof url !== 'string' || url.trim() === '') {
      console.info('BETTER_AUTH_URL not set, using default:', defaultUrl);
      return defaultUrl;
    }
    
    try {
      // Validate URL format and ensure it's a proper origin
      const validatedUrl = new URL(url.trim());
      const cleanUrl = validatedUrl.origin;
      console.info('Using BETTER_AUTH_URL:', cleanUrl);
      return cleanUrl;
    } catch (e) {
      console.error(`Invalid BETTER_AUTH_URL format: "${url}"`);
      console.error('Error:', e);
      console.info('Falling back to default:', defaultUrl);
      return defaultUrl;
    }
  })(),
  basePath: withBase("/api/auth"), // Specify the base path for auth endpoints
  
  // Trusted origins - this is how we support multiple access URLs.
  // Uses the function form so that the origin can be auto-detected from
  // the incoming request's Host / X-Forwarded-* headers, which makes the
  // app work behind a reverse proxy without manual env var configuration.
  trustedOrigins: (request?: Request) => resolveTrustedOrigins(request),

  // Authentication methods
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // We'll enable this later
    sendResetPassword: async ({ user, url }) => {
      // TODO: Implement email sending for password reset
      console.log("Password reset requested for:", user.email);
      console.log("Reset URL:", url);
    },
  },
  

  // Session configuration
  session: {
    cookieName: "better-auth-session",
    updateSessionCookieAge: true,
    expiresIn: 60 * 60 * 24 * 30, // 30 days
  },

  // User configuration
  user: {
    additionalFields: {
      // Keep the username field from our existing schema
      username: {
        type: "string",
        required: false,
        input: false, // Don't show in signup form - we'll derive from email
      }
    },
    changeEmail: {
      enabled: true,
      // Email verification isn't wired up (sendResetPassword is a TODO),
      // so allow direct updates. Safe here because emails stay unverified.
      updateEmailWithoutVerification: true,
    },
  },

  // Account linking configuration.
  //
  // Lets a user who first registered with email/password sign in through SSO
  // and land on the *same* account, instead of being bounced back to /login.
  // Better Auth's auto-link path (link-account.mjs) refuses unless BOTH sides
  // pass:
  //   - upstream: provider is "trusted" (either listed in `trustedProviders`
  //               or the SSO plugin marks it trusted via domainVerified +
  //               domain match) OR userInfo.emailVerified === true
  //   - local:    existing user is verified (or requireLocalEmailVerified=false)
  //
  // We don't wire an email-verification flow, so the local admin always has
  // emailVerified=false — `requireLocalEmailVerified: false` is required.
  //
  // We deliberately do NOT use the catch-all `trustedProviders` list (which
  // would blanket-trust every registered IdP). Instead the SSO provider's
  // own `domainVerified` flag — set to true at registration time, scoped to
  // the operator-supplied `domain` — gates linking. The SSO plugin enforces
  // `validateEmailDomain(userInfo.email, provider.domain)` on top of it, so
  // a sign-in is only auto-linked when (a) the operator vouched for the IdP
  // by registering it, and (b) the user's email actually belongs to the
  // domain that was vouched for. Cross-domain claims from a compromised or
  // permissive IdP do not silently absorb local accounts. (Same-domain
  // claims still require the operator to trust their IdP's identity model.)
  account: {
    accountLinking: {
      enabled: true,
      requireLocalEmailVerified: false,
      // Keep the default (false): never link accounts whose emails differ.
      allowDifferentEmails: false,
    },
  },

  // Plugins configuration
  plugins: [
    // JWT plugin — provides the JWKS keypair that the OAuth provider uses to
    // sign OIDC id_tokens with an asymmetric key (what most relying parties
    // expect). Required by @better-auth/oauth-provider unless disableJwtPlugin
    // is set. Keys are persisted in the `jwks` table.
    jwt(),

    // OAuth 2.1 / OIDC Provider — allows this app to act as an identity
    // provider for other applications. Replaces the deprecated `oidcProvider`
    // plugin (which Better Auth will remove in a future release). Client and
    // consent records now live in the oauth_clients / oauth_consents tables.
    oauthProvider({
      loginPage: withBase("/login"),
      consentPage: withBase("/oauth/consent"),
      // Allow dynamic client registration for flexibility
      allowDynamicClientRegistration: true,
      // Mirror the old getAdditionalUserInfoClaim: expose our extra `username`
      // field on both the userinfo endpoint and the id_token when the
      // "profile" scope is granted.
      customUserInfoClaims: ({ user, scopes }) => {
        const claims: Record<string, any> = {};
        if (scopes.includes("profile")) claims.username = (user as any).username;
        return claims;
      },
      customIdTokenClaims: ({ user, scopes }) => {
        const claims: Record<string, any> = {};
        if (scopes.includes("profile")) claims.username = (user as any).username;
        return claims;
      },
    }),

    // SSO plugin - allows users to authenticate with external OIDC providers
    sso({
      // Provision new users when they sign in with SSO
      provisionUser: async ({ user }: { user: any, userInfo: any }) => {
        // Derive username from email if not provided
        const username = user.name || user.email?.split('@')[0] || 'user';
        
        // Update user in database if needed
        await db.update(users)
          .set({ username })
          .where(eq(users.id, user.id))
          .catch(() => {}); // Ignore errors if user doesn't exist yet
      },
      // Organization provisioning settings
      organizationProvisioning: {
        disabled: false,
        defaultRole: "member",
        getRole: async ({ userInfo }: { user: any, userInfo: any }) => {
          // Check if user has admin attribute from SSO provider
          const isAdmin = userInfo.attributes?.role === 'admin' ||
                         userInfo.attributes?.groups?.includes('admins');
          
          return isAdmin ? "admin" : "member";
        },
      },
      // Override user info with provider data by default
      defaultOverrideUserInfo: true,
      // Allow implicit sign up for new users
      disableImplicitSignUp: false,
      // Trust email_verified claims from the upstream provider so we can link by matching email
      trustEmailVerified: true,
      // Surface `domainVerified` to the model so account-linking can read it.
      //
      // Better Auth's adapter transformOutput (factory.mjs) only copies fields
      // that are declared in the plugin's model schema; the SSO plugin only
      // declares `domainVerified` when this option is enabled. Without it the
      // column is in the DB but stripped from the returned provider object, so
      // the trust check `"domainVerified" in provider` is silently false and
      // sign-ins land on /?error=UNKNOWN. We don't use the DNS-based
      // verify-domain flow this option also exposes — we set
      // `domainVerified: true` directly in src/pages/api/auth/sso/register.ts
      // after the plugin's create, scoped by the operator-supplied `domain`.
      domainVerification: { enabled: true },
    }),

    // Header / forward authentication bridge. Exposes
    // POST /api/auth/sign-in/header so the middleware can mint a real
    // Better Auth session from trusted upstream headers (Authentik /
    // Authelia / oauth2-proxy / Caddy). Without this the SPA's
    // /api/auth/get-session call returns null on header-auth-only
    // requests and bounces the user to /login. See auth-header-plugin.ts.
    headerAuthPlugin(),
  ],
});

// Export type for use in other parts of the app
export type Auth = typeof auth;
