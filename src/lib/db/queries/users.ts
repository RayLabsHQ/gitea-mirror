import { db, users, sqlite } from "../index.js";
import { sql, eq } from "drizzle-orm";

/**
 * Check if any users exist in the database
 */
export async function hasUsers(): Promise<boolean> {
  try {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    
    return result[0].count > 0;
  } catch (error) {
    console.error("Error checking user count:", error);
    return false;
  }
}

/**
 * Get user by ID
 */
export async function getUserById(id: string): Promise<any> {
  try {
    const result = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        displayName: users.displayName,
        authProvider: users.authProvider,
        externalId: users.externalId,
        externalUsername: users.externalUsername,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error("Error getting user by ID:", error);
    return null;
  }
}