import "@/lib/polyfills/buffer";
import { createAuthClient } from "better-auth/react";
import { oidcClient } from "better-auth/client/plugins";
import { ssoClient } from "@better-auth/sso/client";
import type { Session as BetterAuthSession, User as BetterAuthUser } from "better-auth";
import { withBase } from "@/lib/base-path";

function normalizeAuthBaseUrl(url: string): string {
  const validatedUrl = new URL(url.trim());
  return validatedUrl.origin;
}

export const authClient = createAuthClient({
  // Use PUBLIC_BETTER_AUTH_URL if set (for multi-origin access), otherwise use current origin
  // This allows the client to connect to the auth server even when accessed from different origins
  baseURL: (() => {
    let url: string | undefined;
    
    // Check for public environment variable first (for client-side access)
    if (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_BETTER_AUTH_URL) {
      url = import.meta.env.PUBLIC_BETTER_AUTH_URL;
    }
    
    // Validate and clean the URL if provided
    if (url && typeof url === 'string' && url.trim() !== '') {
      try {
        // Validate URL format and preserve optional base path
        return normalizeAuthBaseUrl(url);
      } catch (e) {
        console.warn(`Invalid PUBLIC_BETTER_AUTH_URL: ${url}, falling back to default`);
      }
    }
    
    // Fall back to current origin if running in browser
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }
    
    // Default for SSR - always return a valid URL
    return 'http://localhost:4321';
  })(),
  basePath: withBase('/api/auth'), // Explicitly set the base path
  plugins: [
    oidcClient(),
    ssoClient(),
  ],
});

// Export commonly used methods for convenience
export const {
  signIn,
  signUp,
  signOut,
  useSession,
  sendVerificationEmail,
  resetPassword,
  requestPasswordReset,
  getSession
} = authClient;

// Export types - directly use the types from better-auth
export type Session = BetterAuthSession & {
  user: BetterAuthUser & {
    username?: string | null;
  };
};
export type AuthUser = BetterAuthUser & {
  username?: string | null;
};
