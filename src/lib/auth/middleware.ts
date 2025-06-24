/**
 * Enhanced authentication middleware supporting multiple auth methods
 */

import { ENV } from "@/lib/config";
import { getActiveAuthConfig, isAuthMethodEnabled } from "@/lib/config/db-config";
import { db, users, sqlite } from "@/lib/db";
import jwt from "jsonwebtoken";
import { authenticateForwardAuth } from "./forward-auth";
import { hasUsers as checkHasUsers } from "@/lib/db/queries/users";
import type { User } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const JWT_SECRET = ENV.JWT_SECRET;

export interface AuthResult {
  user: User;
  token: string;
  method: "local" | "forward" | "oidc";
}

/**
 * Authenticate using JWT token (local auth)
 */
async function authenticateJWT(request: Request): Promise<{ user: User; token: string } | null> {
  try {
    const authHeader = request.headers.get("Authorization");
    const cookieHeader = request.headers.get("Cookie");
    
    // Extract token from Authorization header or cookies
    let token: string | undefined;
    
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    } else if (cookieHeader) {
      // Parse cookies to find token - browser sends cookies as "name1=value1; name2=value2"
      const cookies = cookieHeader.split("; ").reduce((acc, cookie) => {
        const [key, ...valueParts] = cookie.split("=");
        if (key && valueParts.length > 0) {
          acc[key] = valueParts.join("="); // Handle values that contain =
        }
        return acc;
      }, {} as Record<string, string>);
      
      token = cookies.token;
      
    }
    
    if (!token) {
      return null;
    }
    
    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string };
    
    // Get user from database - using simpler query for now
    const query = sqlite.query(`
      SELECT id, username, email
      FROM users
      WHERE id = ?
      LIMIT 1
    `);
    
    const user = query.get(decoded.id) as any;
    
    if (!user) {
      return null;
    }
    
    // Add default values for missing fields
    const fullUser: User = {
      ...user,
      password: undefined,
      displayName: user.display_name || user.username,
      authProvider: user.auth_provider || "local",
      externalId: user.external_id || null,
      externalUsername: user.external_username || null,
      isActive: user.is_active !== undefined ? Boolean(user.is_active) : true,
      lastLoginAt: user.last_login_at ? new Date(user.last_login_at) : null,
      createdAt: user.created_at ? new Date(user.created_at) : new Date(),
      updatedAt: user.updated_at ? new Date(user.updated_at) : new Date(),
    };
    
    // Check if user is active (default to true for backward compatibility)
    if (!fullUser.isActive) {
      return null;
    }
    
    return { user: fullUser, token };
    
  } catch (error) {
    // JWT verification failed or other error
    return null;
  }
}

/**
 * Main authentication function that tries different methods based on configuration
 */
export async function authenticate(request: Request): Promise<AuthResult | null> {
  const config = await getActiveAuthConfig();
  
  // Try primary authentication method first
  switch (config.method) {
    case "forward":
      if (await isAuthMethodEnabled("forward")) {
        const forwardResult = await authenticateForwardAuth(request);
        if (forwardResult) {
          return { ...forwardResult, method: "forward" };
        }
      }
      break;
      
    case "oidc":
      // OIDC authentication is handled via redirect flow, not in middleware
      // This case is here for completeness but won't be used in middleware
      break;
      
    case "local":
    default:
      // Local auth is handled below as fallback
      break;
  }
  
  // Try JWT authentication (local auth or fallback)
  if (await isAuthMethodEnabled("local")) {
    const jwtResult = await authenticateJWT(request);
    if (jwtResult) {
      return { ...jwtResult, method: "local" };
    }
  }
  
  // If forward auth is enabled but not primary, try it as fallback
  if (config.method !== "forward" && await isAuthMethodEnabled("forward")) {
    const forwardResult = await authenticateForwardAuth(request);
    if (forwardResult) {
      return { ...forwardResult, method: "forward" };
    }
  }
  
  return null;
}

/**
 * Check if user count is zero (for initial setup)
 * Re-export from queries module for backward compatibility
 */
export const hasUsers = checkHasUsers;

/**
 * Get authentication status for API responses
 */
export async function getAuthStatus(request: Request): Promise<{
  authenticated: boolean;
  user?: User;
  method?: string;
  hasUsers: boolean;
}> {
  const authResult = await authenticate(request);
  const userExists = await hasUsers();
  
  if (authResult) {
    return {
      authenticated: true,
      user: authResult.user,
      method: authResult.method,
      hasUsers: userExists,
    };
  }
  
  return {
    authenticated: false,
    hasUsers: userExists,
  };
}

/**
 * Create authentication response headers
 */
export function createAuthHeaders(token: string): Record<string, string> {
  const isProduction = ENV.NODE_ENV === "production";
  const cookieFlags = isProduction 
    ? "HttpOnly; SameSite=Strict; Secure" 
    : "HttpOnly; SameSite=Strict";
  
  return {
    "Set-Cookie": `token=${token}; Path=/; ${cookieFlags}; Max-Age=${60 * 60 * 24 * 7}`, // 7 days
  };
}

/**
 * Create logout response headers
 */
export function createLogoutHeaders(): Record<string, string> {
  const isProduction = ENV.NODE_ENV === "production";
  const cookieFlags = isProduction 
    ? "HttpOnly; SameSite=Strict; Secure" 
    : "HttpOnly; SameSite=Strict";
  
  return {
    "Set-Cookie": `token=; Path=/; ${cookieFlags}; Max-Age=0`,
  };
}

/**
 * Check if authentication is required for a given path
 */
export function isAuthRequired(pathname: string): boolean {
  // Public paths that don't require authentication
  const publicPaths = [
    "/login",
    "/signup",
    "/setup",
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/oidc",
    "/api/auth/setup",
    "/api/auth/config",
    "/api/health",
    "/_astro",
    "/favicon.ico",
  ];
  
  // Check if path starts with any public path
  return !publicPaths.some(path => pathname.startsWith(path));
}

/**
 * Get redirect URL for authentication
 */
export async function getAuthRedirectUrl(request: Request): Promise<string> {
  const url = new URL(request.url);
  const config = await getActiveAuthConfig();
  
  // For forward auth, redirect to login page (which will auto-redirect)
  if (config.method === "forward") {
    return "/login";
  }
  
  // For OIDC, redirect to OIDC login
  if (config.method === "oidc" && await isAuthMethodEnabled("oidc")) {
    return "/api/auth/oidc/login";
  }
  
  // Default to login page
  return "/login";
}
