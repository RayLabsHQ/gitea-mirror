/**
 * The last data each page showed, kept in memory for this browser tab.
 *
 * The sidebar swaps pages without a reload, and every page used to start from
 * a skeleton and fetch its whole list again. A page now starts from what it
 * showed last time and refreshes behind it. Nothing goes to browser storage:
 * a reload or a new tab starts empty. Entries are per user, so another account
 * signed in on the same tab never sees them, and the server never reads or
 * writes them.
 */

const entries = new Map<string, unknown>();

function key(userId: string, page: string): string {
  return `${userId}\u0000${page}`;
}

export function readPageCache<T>(userId: string | null | undefined, page: string): T | undefined {
  if (typeof window === "undefined" || !userId) return undefined;
  return entries.get(key(userId, page)) as T | undefined;
}

export function writePageCache<T>(userId: string | null | undefined, page: string, value: T): void {
  if (typeof window === "undefined" || !userId) return;
  entries.set(key(userId, page), value);
}
