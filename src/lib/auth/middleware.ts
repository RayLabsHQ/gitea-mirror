/**
 * Enhanced authentication middleware supporting multiple auth methods
 */

import { ENV, AuthConfig } from "@/lib/config";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { authenticateForwardAuth } from "./forward-auth";
import type { User } from "@/lib/db/schema";

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
      // Parse cookies to find token
      const cookies = cookieHeader.split(";").reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split("=");
        acc[key] = value;
        return acc;
      }, {} as Record<string, string>);
      
      token = cookies.token;
    }
    
    if (!token) {
      return null;
    }
    
    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string };
    
    // Get user from database
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.id, decoded.id))
      .limit(1);
    
    if (!userResult.length) {
      return null;
    }
    
    const user = userResult[0];
    
    // Check if user is active
    if (!user.isActive) {
      return null;
    }
    
    return { user, token };
    
  } catch (error) {
    // JWT verification failed or other error
    return null;
  }
}

/**
 * Main authentication function that tries different methods based on configuration
 */
export async function authenticate(request: Request): Promise<AuthResult | null> {
  const primaryMethod = AuthConfig.getPrimaryMethod();
  
  // Try primary authentication method first
  switch (primaryMethod) {
    case "forward":
      if (AuthConfig.isMethodEnabled("forward")) {
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
  if (AuthConfig.isMethodEnabled("local")) {
    const jwtResult = await authenticateJWT(request);
    if (jwtResult) {
      return { ...jwtResult, method: "local" };
    }
  }
  
  // If forward auth is enabled but not primary, try it as fallback
  if (primaryMethod !== "forward" && AuthConfig.isMethodEnabled("forward")) {
    const forwardResult = await authenticateForwardAuth(request);
    if (forwardResult) {
      return { ...forwardResult, method: "forward" };
    }
  }
  
  return null;
}

/**
 * Check if user count is zero (for initial setup)
 */
export async function hasUsers(): Promise<boolean> {
  try {
    const userCount = await db
      .select({ count: users.id })
      .from(users);
    
    return userCount.length > 0;
  } catch (error) {
    console.error("Error checking user count:", error);
    return false;
  }
}

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
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/oidc",
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
export function getAuthRedirectUrl(request: Request): string {
  const url = new URL(request.url);
  const primaryMethod = AuthConfig.getPrimaryMethod();
  
  // For forward auth, redirect to login page (which will auto-redirect)
  if (primaryMethod === "forward") {
    return "/login";
  }
  
  // For OIDC, redirect to OIDC login
  if (primaryMethod === "oidc" && AuthConfig.isMethodEnabled("oidc")) {
    return "/api/auth/oidc/login";
  }
  
  // Default to login page
  return "/login";
}
