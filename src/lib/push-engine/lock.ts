/**
 * One git process per repository at a time.
 *
 * The lock is a file next to the clone directory (the directory itself may
 * not exist yet on the first run). It records the pid and the time it was
 * taken; a lock older than `staleAfterMs` belongs to a run that died and
 * is taken over.
 */
import { open, readFile, rm, stat, mkdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000;

export class CloneLockedError extends Error {
  constructor(public readonly lockPath: string, public readonly heldSince: Date | null) {
    super(
      `Another mirror run holds the lock for this repository${
        heldSince ? ` since ${heldSince.toISOString()}` : ""
      }. Try again once it finishes.`
    );
    this.name = "CloneLockedError";
  }
}

export function lockPathFor(clonePath: string): string {
  return `${clonePath.replace(/[\\/]+$/, "")}.lock`;
}

async function tryTakeLock(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, takenAt: new Date().toISOString() }));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function lockAge(lockPath: string): Promise<{ ageMs: number; takenAt: Date } | null> {
  try {
    const info = await stat(lockPath);
    let takenAt = info.mtime;
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { takenAt?: string };
      if (parsed.takenAt) {
        const fromFile = new Date(parsed.takenAt);
        if (!Number.isNaN(fromFile.getTime())) takenAt = fromFile;
      }
    } catch {
      // Unreadable content: the mtime is good enough.
    }
    return { ageMs: Date.now() - takenAt.getTime(), takenAt };
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding the clone lock. A stale lock is removed and taken
 * over; a live one raises CloneLockedError without waiting.
 */
export async function withCloneLock<T>(
  clonePath: string,
  fn: () => Promise<T>,
  { staleAfterMs = DEFAULT_LOCK_STALE_MS }: { staleAfterMs?: number } = {}
): Promise<T> {
  const lockPath = lockPathFor(clonePath);
  await mkdir(path.dirname(lockPath), { recursive: true });

  let taken = await tryTakeLock(lockPath);
  if (!taken) {
    const age = await lockAge(lockPath);
    if (age && age.ageMs > staleAfterMs) {
      await rm(lockPath, { force: true });
      taken = await tryTakeLock(lockPath);
    }
    if (!taken) {
      throw new CloneLockedError(lockPath, age?.takenAt ?? null);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
