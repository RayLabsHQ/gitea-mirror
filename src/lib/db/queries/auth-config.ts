import { db, authConfig as authConfigTable } from "../index.js";
import type { AuthConfig } from "../schema.js";
import { v4 as uuidv4 } from "uuid";
import { desc, eq, sql } from "drizzle-orm";

/**
 * Get the current auth configuration
 */
export async function getAuthConfig(): Promise<AuthConfig | null> {
  const results = await db
    .select()
    .from(authConfigTable)
    .orderBy(desc(authConfigTable.createdAt))
    .limit(1);
  
  if (results.length === 0) return null;
  
  const result = results[0];
  
  // The JSON fields are already parsed by Drizzle
  return {
    id: result.id,
    method: result.method as "local" | "forward" | "oidc",
    allowLocalFallback: result.allowLocalFallback,
    forwardAuth: result.forwardAuth || undefined,
    oidc: result.oidc || undefined,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  };
}

/**
 * Save auth configuration
 */
export async function saveAuthConfig(config: Omit<AuthConfig, "id" | "createdAt" | "updatedAt">): Promise<AuthConfig> {
  const id = uuidv4();
  const now = new Date();
  
  // Check if there's already a config
  const existing = await getAuthConfig();
  
  if (existing) {
    // Update existing config
    const updated = await db
      .update(authConfigTable)
      .set({
        method: config.method,
        allowLocalFallback: config.allowLocalFallback,
        forwardAuth: config.forwardAuth || null,
        oidc: config.oidc || null,
        updatedAt: now,
      })
      .where(eq(authConfigTable.id, existing.id))
      .returning();
    
    return {
      id: updated[0].id,
      method: updated[0].method as "local" | "forward" | "oidc",
      allowLocalFallback: updated[0].allowLocalFallback,
      forwardAuth: updated[0].forwardAuth || undefined,
      oidc: updated[0].oidc || undefined,
      createdAt: updated[0].createdAt,
      updatedAt: updated[0].updatedAt,
    };
  } else {
    // Create new config
    const inserted = await db
      .insert(authConfigTable)
      .values({
        id,
        method: config.method,
        allowLocalFallback: config.allowLocalFallback,
        forwardAuth: config.forwardAuth || null,
        oidc: config.oidc || null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    
    return {
      id: inserted[0].id,
      method: inserted[0].method as "local" | "forward" | "oidc",
      allowLocalFallback: inserted[0].allowLocalFallback,
      forwardAuth: inserted[0].forwardAuth || undefined,
      oidc: inserted[0].oidc || undefined,
      createdAt: inserted[0].createdAt,
      updatedAt: inserted[0].updatedAt,
    };
  }
}

/**
 * Delete auth configuration (for testing)
 */
export async function deleteAuthConfig(): Promise<void> {
  await db.delete(authConfigTable);
}

/**
 * Check if auth configuration exists
 */
export async function hasAuthConfig(): Promise<boolean> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(authConfigTable);
  
  return result[0].count > 0;
}