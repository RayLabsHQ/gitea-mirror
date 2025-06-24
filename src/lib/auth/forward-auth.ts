/**
 * Forward Authentication (Header-based) implementation
 * For use with reverse proxies like Authentik, Authelia, etc.
 */

import { ENV } from "@/lib/config";
import { getActiveAuthConfig } from "@/lib/config/db-config";
import { db, users, sqlite } from "@/lib/db";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import type { User } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

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
    displayName,
    groups,
  };
}

/**
 * Validate that the request comes from a trusted proxy
 */
export async function validateTrustedProxy(request: Request): Promise<boolean> {
  const config = await getActiveAuthConfig();
  
  if (!config.forwardAuth) {
    return false;
  }
  
  // If no trusted proxies are configured, deny (security by default)
  if (config.forwardAuth.trustedProxies.length === 0) {
    console.warn("Forward Auth: No trusted proxies configured");
    return false;
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
  const isTrusted = config.forwardAuth.trustedProxies.includes(proxyIP);
  
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
    let existingUser: User | undefined;
    
    // Try to find by external username
    const byExternalQuery = sqlite.query(`
      SELECT id, username, email, displayName, authProvider, externalId, externalUsername, isActive, lastLoginAt
      FROM users
      WHERE authProvider = 'forward' AND externalUsername = ?
      LIMIT 1
    `);
    existingUser = byExternalQuery.get(forwardAuthUser.username) as User | undefined;
    
    if (!existingUser) {
      // Try to find by email
      const byEmailQuery = sqlite.query(`
        SELECT id, username, email, displayName, authProvider, externalId, externalUsername, isActive, lastLoginAt
        FROM users
        WHERE email = ?
        LIMIT 1
      `);
      existingUser = byEmailQuery.get(forwardAuthUser.email) as User | undefined;
    }
    
    if (existingUser) {
      // Update existing user with latest information
      const updateQuery = sqlite.prepare(`
        UPDATE users
        SET displayName = ?,
            authProvider = 'forward',
            externalUsername = ?,
            lastLoginAt = ?,
            updatedAt = ?
        WHERE id = ?
      `);
      
      const now = new Date().toISOString();
      updateQuery.run(
        forwardAuthUser.displayName || existingUser.displayName,
        forwardAuthUser.username,
        now,
        now,
        existingUser.id
      );
      
      // Return updated user
      const getUpdatedQuery = sqlite.query(`
        SELECT id, username, email, displayName, authProvider, externalId, externalUsername, isActive, lastLoginAt
        FROM users
        WHERE id = ?
      `);
      return getUpdatedQuery.get(existingUser.id) as User;
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
    
    const checkUsernameQuery = sqlite.query(`
      SELECT COUNT(*) as count FROM users WHERE username = ?
    `);
    
    while (true) {
      const result = checkUsernameQuery.get(username) as { count: number };
      
      if (result.count === 0) {
        break;
      }
      
      username = `${forwardAuthUser.username}_${counter}`;
      counter++;
    }
    
    // Create new user
    const userId = uuidv4();
    const now = new Date().toISOString();
    
    const insertQuery = sqlite.prepare(`
      INSERT INTO users (
        id, username, email, displayName, authProvider, 
        externalUsername, isActive, lastLoginAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    insertQuery.run(
      userId,
      username,
      forwardAuthUser.email,
      forwardAuthUser.displayName || forwardAuthUser.username,
      "forward",
      forwardAuthUser.username,
      1, // isActive
      now,
      now,
      now
    );
    
    // Get the created user
    const getNewUserQuery = sqlite.query(`
      SELECT id, username, email, displayName, authProvider, externalId, externalUsername, isActive, lastLoginAt
      FROM users
      WHERE id = ?
    `);
    
    const newUser = getNewUserQuery.get(userId) as User;
    
    console.log(`Forward Auth: Created new user ${username} for external user ${forwardAuthUser.username}`);
    return newUser;
    
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
export async function isForwardAuthConfigured(): Promise<boolean> {
  const config = await getActiveAuthConfig();
  return !!(config.forwardAuth?.userHeader && config.forwardAuth?.emailHeader);
}
