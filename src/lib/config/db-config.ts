import { getAuthConfig } from "../db/queries/auth-config.js";
import { ENV } from "../config.js";
import type { AuthConfig } from "../db/schema.js";

// Cache auth config for performance
let cachedConfig: AuthConfig | null = null;
let cacheExpiry = 0;
const CACHE_DURATION = 60000; // 1 minute

/**
 * Get authentication configuration from database or environment
 * Database configuration takes precedence over environment variables
 */
export async function getActiveAuthConfig(): Promise<{
  method: "local" | "forward" | "oidc";
  allowLocalFallback: boolean;
  forwardAuth?: {
    userHeader: string;
    emailHeader: string;
    nameHeader?: string;
    groupsHeader?: string;
    trustedProxies: string[];
    autoCreateUsers: boolean;
  };
  oidc?: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    scopes: string[];
    autoCreateUsers: boolean;
    usernameClaim: string;
    emailClaim: string;
    nameClaim: string;
  };
}> {
  // Check cache
  if (cachedConfig && Date.now() < cacheExpiry) {
    return formatConfig(cachedConfig);
  }
  
  // Try to get config from database
  const dbConfig = await getAuthConfig();
  
  if (dbConfig) {
    // Cache the config
    cachedConfig = dbConfig;
    cacheExpiry = Date.now() + CACHE_DURATION;
    return formatConfig(dbConfig);
  }
  
  // Fall back to environment variables
  const envConfig = {
    method: ENV.AUTH_METHOD as "local" | "forward" | "oidc",
    allowLocalFallback: ENV.AUTH_ALLOW_LOCAL_FALLBACK,
    forwardAuth: ENV.AUTH_METHOD === "forward" ? {
      userHeader: ENV.AUTH_FORWARD_USER_HEADER,
      emailHeader: ENV.AUTH_FORWARD_EMAIL_HEADER,
      nameHeader: ENV.AUTH_FORWARD_NAME_HEADER,
      groupsHeader: ENV.AUTH_FORWARD_GROUPS_HEADER,
      trustedProxies: ENV.AUTH_FORWARD_TRUSTED_PROXIES.split(",").map(ip => ip.trim()).filter(Boolean),
      autoCreateUsers: ENV.AUTH_FORWARD_AUTO_CREATE_USERS,
    } : undefined,
    oidc: ENV.AUTH_METHOD === "oidc" ? {
      issuerUrl: ENV.AUTH_OIDC_ISSUER_URL,
      clientId: ENV.AUTH_OIDC_CLIENT_ID,
      clientSecret: ENV.AUTH_OIDC_CLIENT_SECRET,
      redirectUri: ENV.AUTH_OIDC_REDIRECT_URI,
      scopes: ENV.AUTH_OIDC_SCOPES.split(" ").filter(Boolean),
      autoCreateUsers: ENV.AUTH_OIDC_AUTO_CREATE_USERS,
      usernameClaim: ENV.AUTH_OIDC_CLAIM_USERNAME,
      emailClaim: ENV.AUTH_OIDC_CLAIM_EMAIL,
      nameClaim: ENV.AUTH_OIDC_CLAIM_NAME,
    } : undefined,
  };
  
  return envConfig;
}

/**
 * Format auth config for consistent output
 */
function formatConfig(config: AuthConfig) {
  return {
    method: config.method,
    allowLocalFallback: config.allowLocalFallback,
    forwardAuth: config.forwardAuth,
    oidc: config.oidc,
  };
}

/**
 * Clear the config cache (useful after updates)
 */
export function clearAuthConfigCache() {
  cachedConfig = null;
  cacheExpiry = 0;
}

/**
 * Check if a specific auth method is enabled and configured
 */
export async function isAuthMethodEnabled(method: "local" | "forward" | "oidc"): Promise<boolean> {
  const config = await getActiveAuthConfig();
  
  if (config.method !== method && !config.allowLocalFallback) {
    return false;
  }
  
  if (method === "local") {
    return config.method === "local" || config.allowLocalFallback;
  }
  
  if (method === "forward" && config.method === "forward") {
    return !!(config.forwardAuth && config.forwardAuth.trustedProxies.length > 0);
  }
  
  if (method === "oidc" && config.method === "oidc") {
    return !!(config.oidc && config.oidc.issuerUrl && config.oidc.clientId && config.oidc.clientSecret);
  }
  
  return false;
}