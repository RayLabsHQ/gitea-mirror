/**
 * Turning two-factor authentication off from the command line (#552), for an
 * account whose phone and backup codes are both gone:
 *
 *   bun run disable-2fa -- --email=user@example.com
 *
 * It needs access to the database file, so only whoever runs the server can
 * use it, the same as reset-password.
 */
import { and, eq, like } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { twoFactors, users, verifications } from "./db/schema";

export interface DisableTwoFactorResult {
  /** No account has that email. */
  found: boolean;
  /** Two-factor was on before. */
  wasEnabled: boolean;
  /** Browsers that had been trusted to skip the code, now forgotten. */
  trustedDevicesCleared: number;
}

export async function disableTwoFactorForEmail(
  db: BunSQLiteDatabase<any>,
  rawEmail: string,
): Promise<DisableTwoFactorResult> {
  const email = rawEmail.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) return { found: false, wasEnabled: false, trustedDevicesCleared: 0 };

  const wasEnabled = user.twoFactorEnabled === true;
  await db.update(users).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(users.id, user.id));
  await db.delete(twoFactors).where(eq(twoFactors.userId, user.id));
  // A trusted browser would otherwise skip the code again once it is turned
  // back on, until its 30 days are up.
  const cleared = await db
    .delete(verifications)
    .where(and(like(verifications.identifier, "trust-device-%"), eq(verifications.value, user.id)))
    .returning({ id: verifications.id });

  return { found: true, wasEnabled, trustedDevicesCleared: cleared.length };
}
