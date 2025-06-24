/**
 * Application configuration
 */

// Authentication methods
export type AuthMethod = "local" | "forward" | "oidc";

// Environment variables
export const ENV = {
  // Runtime environment (development, production, test)
  NODE_ENV: process.env.NODE_ENV || "development",

  // Database URL - use SQLite by default
  get DATABASE_URL() {
    // If explicitly set, use the provided DATABASE_URL
    if (process.env.DATABASE_URL) {
      return process.env.DATABASE_URL;
    }

    // Otherwise, use the default database
    return "sqlite://data/gitea-mirror.db";
  },

  // JWT secret for authentication
  JWT_SECRET:
    process.env.JWT_SECRET || "your-secret-key-change-this-in-production",

  // Server host and port
  HOST: process.env.HOST || "localhost",
  PORT: parseInt(process.env.PORT || "4321", 10),

  // Authentication configuration
  AUTH: {
    // Primary authentication method
    METHOD: (process.env.AUTH_METHOD as AuthMethod) || "local",

    // Allow fallback to local auth if external auth fails
    ALLOW_LOCAL_FALLBACK: process.env.AUTH_ALLOW_LOCAL_FALLBACK === "true",

    // Forward Auth configuration (for reverse proxy setups)
    FORWARD: {
      // Header containing the username
      USER_HEADER: process.env.AUTH_FORWARD_USER_HEADER || "X-Remote-User",
      // Header containing the email
      EMAIL_HEADER: process.env.AUTH_FORWARD_EMAIL_HEADER || "X-Remote-Email",
      // Header containing the display name (optional)
      NAME_HEADER: process.env.AUTH_FORWARD_NAME_HEADER || "X-Remote-Name",
      // Header containing user groups (optional, comma-separated)
      GROUPS_HEADER: process.env.AUTH_FORWARD_GROUPS_HEADER || "X-Remote-Groups",
      // Trusted proxy IPs (comma-separated, optional)
      TRUSTED_PROXIES: process.env.AUTH_FORWARD_TRUSTED_PROXIES?.split(",") || [],
      // Auto-create users if they don't exist
      AUTO_CREATE_USERS: process.env.AUTH_FORWARD_AUTO_CREATE !== "false",
    },

    // OIDC configuration
    OIDC: {
      // OIDC provider URL (e.g., https://auth.example.com/application/o/gitea-mirror/)
      ISSUER_URL: process.env.AUTH_OIDC_ISSUER_URL || "",
      // Client ID
      CLIENT_ID: process.env.AUTH_OIDC_CLIENT_ID || "",
      // Client Secret
      CLIENT_SECRET: process.env.AUTH_OIDC_CLIENT_SECRET || "",
      // Redirect URI (will be auto-generated if not provided)
      REDIRECT_URI: process.env.AUTH_OIDC_REDIRECT_URI || "",
      // Scopes to request
      SCOPES: process.env.AUTH_OIDC_SCOPES?.split(",") || ["openid", "profile", "email"],
      // Auto-create users if they don't exist
      AUTO_CREATE_USERS: process.env.AUTH_OIDC_AUTO_CREATE !== "false",
      // Username claim in the ID token
      USERNAME_CLAIM: process.env.AUTH_OIDC_USERNAME_CLAIM || "preferred_username",
      // Email claim in the ID token
      EMAIL_CLAIM: process.env.AUTH_OIDC_EMAIL_CLAIM || "email",
      // Name claim in the ID token
      NAME_CLAIM: process.env.AUTH_OIDC_NAME_CLAIM || "name",
    },
  },
};

/**
 * Authentication configuration helpers
 */
export const AuthConfig = {
  /**
   * Check if authentication method is enabled
   */
  isMethodEnabled(method: AuthMethod): boolean {
    if (method === "local") {
      return true; // Local auth is always available
    }

    if (method === "forward") {
      return ENV.AUTH.METHOD === "forward" || ENV.AUTH.ALLOW_LOCAL_FALLBACK;
    }

    if (method === "oidc") {
      return ENV.AUTH.METHOD === "oidc" &&
             ENV.AUTH.OIDC.ISSUER_URL &&
             ENV.AUTH.OIDC.CLIENT_ID &&
             ENV.AUTH.OIDC.CLIENT_SECRET;
    }

    return false;
  },

  /**
   * Get the primary authentication method
   */
  getPrimaryMethod(): AuthMethod {
    return ENV.AUTH.METHOD;
  },

  /**
   * Check if local fallback is allowed
   */
  isLocalFallbackAllowed(): boolean {
    return ENV.AUTH.ALLOW_LOCAL_FALLBACK;
  },

  /**
   * Get OIDC redirect URI (auto-generate if not provided)
   */
  getOIDCRedirectURI(): string {
    if (ENV.AUTH.OIDC.REDIRECT_URI) {
      return ENV.AUTH.OIDC.REDIRECT_URI;
    }

    // Auto-generate redirect URI
    const protocol = ENV.NODE_ENV === "production" ? "https" : "http";
    const host = ENV.HOST === "0.0.0.0" ? "localhost" : ENV.HOST;
    return `${protocol}://${host}:${ENV.PORT}/api/auth/oidc/callback`;
  },

  /**
   * Validate OIDC configuration
   */
  validateOIDCConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!ENV.AUTH.OIDC.ISSUER_URL) {
      errors.push("OIDC Issuer URL is required");
    }

    if (!ENV.AUTH.OIDC.CLIENT_ID) {
      errors.push("OIDC Client ID is required");
    }

    if (!ENV.AUTH.OIDC.CLIENT_SECRET) {
      errors.push("OIDC Client Secret is required");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },

  /**
   * Validate Forward Auth configuration
   */
  validateForwardAuthConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!ENV.AUTH.FORWARD.USER_HEADER) {
      errors.push("Forward Auth user header is required");
    }

    if (!ENV.AUTH.FORWARD.EMAIL_HEADER) {
      errors.push("Forward Auth email header is required");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};
