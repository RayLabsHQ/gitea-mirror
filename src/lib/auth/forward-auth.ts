/**
 * Forward Authentication (Header-based) implementation
 * For use with reverse proxies like Authentik, Authelia, etc.
 */

import { ENV } from "@/lib/config";
import { getActiveAuthConfig } from "@/lib/config/db-config";
import { getDb, users, type User } from "@/lib/db";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { eq, and, or } from "drizzle-orm";

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
export async function extractForwardAuthUser(request: Request): Promise<ForwardAuthUser | null> {
  const config = await getActiveAuthConfig();
  
  if (!config.forwardAuth) {
    return null;
  }
  
  const userHeader = request.headers.get(config.forwardAuth.userHeader);
  const emailHeader = request.headers.get(config.forwardAuth.emailHeader);
  
  if (!userHeader || !emailHeader) {
    return null;
  }
  
  const displayName = config.forwardAuth.nameHeader 
    ? request.headers.get(config.forwardAuth.nameHeader) || undefined 
    : undefined;
  const groupsHeader = config.forwardAuth.groupsHeader 
    ? request.headers.get(config.forwardAuth.groupsHeader) 
    : null;
  const groups = groupsHeader ? groupsHeader.split(",").map(g => g.trim()) : undefined;
  
  return {
    username: userHeader.trim(),
    email: emailHeader.trim(),
    displayName: displayName?.trim(),
    groups,
  };
}

/**
 * Validate that the request is coming from a trusted proxy
 */
export async function validateTrustedProxy(request: Request): Promise<boolean> {
  const config = await getActiveAuthConfig();
  
  if (!config.forwardAuth || !config.forwardAuth.trustedProxies?.length) {
    // No trusted proxies configured, deny by default for security
    return false;
  }
  
  // Get the real IP from X-Forwarded-For or X-Real-IP
  let clientIP = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip");
  
  if (clientIP) {
    // X-Forwarded-For can contain multiple IPs, get the last one (closest proxy)
    const ips = clientIP.split(",").map(ip => ip.trim());
    clientIP = ips[ips.length - 1];
  }
  
  // Fallback to connection remote address if available
  if (!clientIP && (request as any).socket?.remoteAddress) {
    clientIP = (request as any).socket.remoteAddress;
  }
  
  if (!clientIP) {
    console.warn("Forward Auth: Unable to determine client IP");
    return false;
  }
  
  // Check if the IP is in the trusted proxy list
  const isTrusted = config.forwardAuth.trustedProxies.some(trustedIP => {
    // Simple string comparison for now
    // TODO: Add CIDR range support
    return clientIP === trustedIP;
  });
  
  if (!isTrusted) {
    const proxyIP = clientIP.includes(":") && !clientIP.includes("[") 
      ? `[${clientIP}]` 
      : clientIP;
    console.warn(`Forward Auth: Untrusted proxy IP: ${proxyIP}`);
  }
  
  return isTrusted;
}

/**
 * Find or create a user based on forward auth information
 */
export async function findOrCreateForwardAuthUser(forwardAuthUser: ForwardAuthUser): Promise<User | null> {
  try {
    const db = await getDb();
    
    // First, try to find existing user by external username or email
    const existingUsers = await db.select()
      .from(users)
      .where(
        or(
          and(
            eq(users.authProvider, "forward"),
            eq(users.externalUsername, forwardAuthUser.username)
          ),
          eq(users.email, forwardAuthUser.email)
        )
      )
      .limit(1);
    
    const existingUser = existingUsers[0];
    
    if (existingUser) {
      // Update existing user with latest information
      await db.update(users)
        .set({
          displayName: forwardAuthUser.displayName || existingUser.displayName,
          authProvider: "forward",
          externalUsername: forwardAuthUser.username,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUser.id));
      
      // Return updated user
      const updatedUsers = await db.select()
        .from(users)
        .where(eq(users.id, existingUser.id))
        .limit(1);
      
      return updatedUsers[0];
    }
    
    const config = await getActiveAuthConfig();
    
    // Create new user if auto-creation is enabled
    if (!config.forwardAuth?.autoCreateUsers) {
      console.warn(`Forward Auth: User ${forwardAuthUser.username} not found and auto-creation is disabled`);
      return null;
    }
    
    // Generate a unique username if needed
    let username = forwardAuthUser.username;
    let counter = 1;
    
    while (true) {
      const existing = await db.select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      
      if (existing.length === 0) {
        break;
      }
      
      username = `${forwardAuthUser.username}_${counter}`;
      counter++;
    }
    
    // Create new user
    const userId = uuidv4();
    const now = new Date();
    
    await db.insert(users).values({
      id: userId,
      username,
      email: forwardAuthUser.email,
      password: null, // No password for forward auth users
      displayName: forwardAuthUser.displayName || forwardAuthUser.username,
      authProvider: "forward",
      externalUsername: forwardAuthUser.username,
      isActive: true,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    });
    
    console.log(`Forward Auth: Created new user ${username} (${forwardAuthUser.email})`);
    
    // Return the newly created user
    const newUsers = await db.select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    
    return newUsers[0];
  } catch (error) {
    console.error("Forward Auth: Error finding/creating user:", error);
    return null;
  }
}

/**
 * Authenticate a user using forward auth headers
 */
export async function authenticateForwardAuth(request: Request): Promise<{ user: User; token: string } | null> {
  // Validate trusted proxy
  if (!await validateTrustedProxy(request)) {
    return null;
  }
  
  // Extract user information from headers
  const forwardAuthUser = await extractForwardAuthUser(request);
  if (!forwardAuthUser) {
    return null;
  }
  
  // Find or create user
  const user = await findOrCreateForwardAuthUser(forwardAuthUser);
  if (!user || !user.isActive) {
    return null;
  }
  
  // Generate JWT token
  const token = jwt.sign(
    { 
      id: user.id,
      username: user.username,
      email: user.email,
      method: "forward"
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
  
  // Return user without password
  const { password, ...safeUser } = user;
  return { user: safeUser as User, token };
}