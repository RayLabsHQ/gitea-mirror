/**
 * Forward Authentication (Header-based) implementation
 * For use with reverse proxies like Authentik, Authelia, etc.
 */

import { ENV } from "@/lib/config";
import { db, users } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import jwt from "jsonwebtoken";
import type { User } from "@/lib/db/schema";

const JWT_SECRET = ENV.JWT_SECRET;

export interface ForwardAuthUser {
  username: string;
  email: string;
  displayName?: string;
  groups?: string[];
}

/**
 * Extract user information from forward auth headers
 */
export function extractForwardAuthUser(request: Request): ForwardAuthUser | null {
  const userHeader = request.headers.get(ENV.AUTH.FORWARD.USER_HEADER);
  const emailHeader = request.headers.get(ENV.AUTH.FORWARD.EMAIL_HEADER);
  
  if (!userHeader || !emailHeader) {
    return null;
  }
  
  const displayName = request.headers.get(ENV.AUTH.FORWARD.NAME_HEADER) || undefined;
  const groupsHeader = request.headers.get(ENV.AUTH.FORWARD.GROUPS_HEADER);
  const groups = groupsHeader ? groupsHeader.split(",").map(g => g.trim()) : undefined;
  
  return {
    username: userHeader.trim(),
    email: emailHeader.trim(),
    displayName,
    groups,
  };
}

/**
 * Validate that the request comes from a trusted proxy
 */
export function validateTrustedProxy(request: Request): boolean {
  // If no trusted proxies are configured, allow all (for backward compatibility)
  if (ENV.AUTH.FORWARD.TRUSTED_PROXIES.length === 0) {
    return true;
  }
  
  // Get the immediate proxy IP (the last proxy in the chain)
  const forwardedFor = request.headers.get("X-Forwarded-For");
  const realIP = request.headers.get("X-Real-IP");
  
  let proxyIP: string | undefined;
  
  if (forwardedFor) {
    // X-Forwarded-For format: "client, proxy1, proxy2"
    // We want the last proxy (the one directly connecting to us)
    const ips = forwardedFor.split(",").map(ip => ip.trim());
    proxyIP = ips[ips.length - 1];
  } else if (realIP) {
    // X-Real-IP typically contains the immediate proxy
    proxyIP = realIP;
  }
  
  // Note: In a production environment, you should also check request.socket.remoteAddress
  // However, this may not be available in all environments (e.g., serverless)
  
  if (!proxyIP) {
    console.warn("Forward Auth: No proxy IP found in headers");
    return false;
  }
  
  // Check if the proxy IP is in the trusted list
  const isTrusted = ENV.AUTH.FORWARD.TRUSTED_PROXIES.includes(proxyIP);
  
  if (!isTrusted) {
    console.warn(`Forward Auth: Untrusted proxy IP: ${proxyIP}`);
  }
  
  return isTrusted;
}

/**
 * Find or create a user based on forward auth information
 */
export async function findOrCreateForwardAuthUser(forwardAuthUser: ForwardAuthUser): Promise<User | null> {
  try {
    // First, try to find existing user by external username or email
    let existingUser = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.authProvider, "forward"),
          eq(users.externalUsername, forwardAuthUser.username)
        )
      )
      .limit(1);
    
    if (!existingUser.length) {
      // Try to find by email
      existingUser = await db
        .select()
        .from(users)
        .where(eq(users.email, forwardAuthUser.email))
        .limit(1);
    }
    
    if (existingUser.length > 0) {
      // Update existing user with latest information
      const updatedUser = await db
        .update(users)
        .set({
          displayName: forwardAuthUser.displayName,
          authProvider: "forward",
          externalUsername: forwardAuthUser.username,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUser[0].id))
        .returning();
      
      return updatedUser[0];
    }
    
    // Create new user if auto-creation is enabled
    if (!ENV.AUTH.FORWARD.AUTO_CREATE_USERS) {
      console.warn(`Forward Auth: User ${forwardAuthUser.username} not found and auto-creation is disabled`);
      return null;
    }
    
    // Generate a unique username if needed
    let username = forwardAuthUser.username;
    let counter = 1;
    
    while (true) {
      const existingByUsername = await db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      
      if (existingByUsername.length === 0) {
        break;
      }
      
      username = `${forwardAuthUser.username}_${counter}`;
      counter++;
    }
    
    // Create new user
    const newUser = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        username,
        email: forwardAuthUser.email,
        displayName: forwardAuthUser.displayName,
        authProvider: "forward",
        externalUsername: forwardAuthUser.username,
        isActive: true,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    
    console.log(`Forward Auth: Created new user ${username} for external user ${forwardAuthUser.username}`);
    return newUser[0];
    
  } catch (error) {
    console.error("Forward Auth: Error finding/creating user:", error);
    return null;
  }
}

/**
 * Authenticate a request using forward auth headers
 */
export async function authenticateForwardAuth(request: Request): Promise<{ user: User; token: string } | null> {
  try {
    // Validate trusted proxy if configured
    if (!validateTrustedProxy(request)) {
      return null;
    }
    
    // Extract user information from headers
    const forwardAuthUser = extractForwardAuthUser(request);
    if (!forwardAuthUser) {
      return null;
    }
    
    // Find or create user
    const user = await findOrCreateForwardAuthUser(forwardAuthUser);
    if (!user) {
      return null;
    }
    
    // Check if user is active
    if (!user.isActive) {
      console.warn(`Forward Auth: User ${user.username} is inactive`);
      return null;
    }
    
    // Generate JWT token
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "7d" });
    
    return { user, token };
    
  } catch (error) {
    console.error("Forward Auth: Authentication error:", error);
    return null;
  }
}

/**
 * Check if forward auth is properly configured
 */
export function isForwardAuthConfigured(): boolean {
  return !!(ENV.AUTH.FORWARD.USER_HEADER && ENV.AUTH.FORWARD.EMAIL_HEADER);
}
