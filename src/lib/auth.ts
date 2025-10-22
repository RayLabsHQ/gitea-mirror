import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { oidcProvider } from "better-auth/plugins";
import { sso } from "@better-auth/sso";
import { db, users } from "./db";
import * as schema from "./db/schema";
import { eq } from "drizzle-orm";

export const auth = betterAuth({
  // Database configuration
  database: drizzleAdapter(db, {
    provider: "sqlite",
    usePlural: true, // Our tables use plural names (users, not user)
    schema, // Pass the schema explicitly
  }),

  // Secret for signing tokens
  secret: process.env.BETTER_AUTH_SECRET,

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
      const cleanUrl = validatedUrl.origin; // Use origin to ensure no trailing paths
      console.info('Using BETTER_AUTH_URL:', cleanUrl);
      return cleanUrl;
    } catch (e) {
      console.error(`Invalid BETTER_AUTH_URL format: "${url}"`);
      console.error('Error:', e);
      console.info('Falling back to default:', defaultUrl);
      return defaultUrl;
    }
  })(),
  basePath: "/api/auth", // Specify the base path for auth endpoints
  
  // Trusted origins - this is how we support multiple access URLs
  trustedOrigins: (() => {
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
    // This is where users can specify multiple access URLs
    if (process.env.BETTER_AUTH_TRUSTED_ORIGINS) {
      const additionalOrigins = process.env.BETTER_AUTH_TRUSTED_ORIGINS
        .split(',')
        .map(o => o.trim())
        .filter(o => o !== '');
      
      // Validate each additional origin
      for (const origin of additionalOrigins) {
        try {
          const validatedUrl = new URL(origin);
          origins.push(validatedUrl.origin);
        } catch {
          console.warn(`Invalid trusted origin: ${origin}, skipping`);
        }
      }
    }
    
    // Remove duplicates and empty strings, then return
    const uniqueOrigins = [...new Set(origins.filter(Boolean))];
    console.info('Trusted origins:', uniqueOrigins);
    return uniqueOrigins;
  })(),

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
  },

  // Plugins configuration
  plugins: [
    // OIDC Provider plugin - allows this app to act as an OIDC provider
    oidcProvider({
      loginPage: "/login",
      consentPage: "/oauth/consent",
      // Allow dynamic client registration for flexibility
      allowDynamicClientRegistration: true,
      // Note: trustedClients would be configured here if Better Auth supports it
      // For now, we'll use dynamic registration
      // Customize user info claims based on scopes
      getAdditionalUserInfoClaim: (user, scopes) => {
        const claims: Record<string, any> = {};
        if (scopes.includes("profile")) {
          claims.username = user.username;
        }
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
    }),
  ],
});

// Export type for use in other parts of the app
export type Auth = typeof auth;
