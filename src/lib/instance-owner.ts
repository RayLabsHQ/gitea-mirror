import { asc, sql } from "drizzle-orm";
import { db, users } from "@/lib/db";

/**
 * The instance owner is the first account created on this instance. It is
 * the only account that can manage settings that apply to every account:
 * the SSO providers people sign in with, and the OAuth applications this
 * instance signs people in to. No other account can become owner.
 *
 * SSO providers used to belong to whoever created them, but sign-in looks
 * providers up across the whole instance. Any signed-in user could register
 * a provider for another user's email domain, sign in through it with that
 * user's email, and be linked into their account (GHSA-c6c2-hr73-h7hw).
 */
export async function getInstanceOwnerId(): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    // created_at only has whole seconds. Two accounts made in the same
    // second are told apart by rowid, which follows insertion order; the
    // random id would pick one by chance.
    .orderBy(asc(users.createdAt), asc(sql`rowid`))
    .limit(1);
  return row?.id ?? null;
}

export async function isInstanceOwner(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return (await getInstanceOwnerId()) === userId;
}

export const OWNER_ONLY_CODE = "OWNER_ONLY";

export const OWNER_ONLY_MESSAGE =
  "Only the instance owner (the first account created on this instance) can manage SSO providers and OAuth applications.";

export function ownerOnlyResponse(): Response {
  return new Response(JSON.stringify({ error: OWNER_ONLY_MESSAGE, code: OWNER_ONLY_CODE }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
