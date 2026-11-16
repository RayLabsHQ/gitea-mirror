/**
 * Waiting for an import Gitea is still running (#496, #521).
 *
 * The migrate call stays open until the clone is done, and Gitea (Forgejo too)
 * carries on with the import when the caller stops waiting: a reverse proxy
 * timing out on it (#496), or this app, whose requests give up after five
 * minutes (Bun's fetch default), on a large repository (#521). The repository
 * is created first and gets its mirror record only after the clone. Until then
 * the API answers `empty: true` with an empty `mirror_interval`, mirror-sync
 * refuses it as "not a mirror", and none of the tags a release needs exist yet.
 * Seen on Gitea 1.24.7 and Forgejo 17.0.1.
 *
 * An import that fails is not cleaned up on either server: the repository stays
 * in exactly that state, and the API cannot tell it from one still running.
 */

/** Long enough for a large clone; a retry after this waits again. */
export const GITEA_IMPORT_WAIT_MS = 30 * 60 * 1000;
export const GITEA_IMPORT_POLL_MS = 5_000;

interface GiteaImportState {
  empty?: boolean;
  mirror_interval?: string;
}

/**
 * Strict on purpose: a server that leaves the fields out is not importing as far
 * as anyone can tell, and must not hold a mirror up. A mirror of an empty source
 * still gets its interval when the import ends.
 */
export function isGiteaImportRunning(repoInfo: GiteaImportState): boolean {
  return repoInfo.empty === true && repoInfo.mirror_interval === "";
}

/**
 * Whether a failed migrate call only means nobody waited for the answer: a
 * network error, which is how our own request timeout surfaces (status 0), or a
 * proxy in front of the server giving up (502, 504). The import itself may well
 * be running, so the caller looks before reporting a failure.
 */
export function isMigrateCutOff(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 0 || status === 502 || status === 504;
}

/**
 * Resolves with the repository once the import has finished, or with `initial`
 * right away when none is running. Throws when the repository disappears, or
 * when the wait runs out; the row then fails with that message and a retry
 * picks it up from there.
 */
export async function waitForGiteaImport<T extends GiteaImportState>({
  location,
  initial,
  readRepo,
  waitMs = GITEA_IMPORT_WAIT_MS,
  pollMs = GITEA_IMPORT_POLL_MS,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}: {
  /** owner/name, for the messages. */
  location: string;
  initial: T;
  readRepo: () => Promise<T | null>;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<T> {
  if (!isGiteaImportRunning(initial)) {
    return initial;
  }

  const minutes = Math.round(waitMs / 60_000);
  console.log(`Gitea is still importing ${location}. Waiting up to ${minutes} minutes for it to finish.`);

  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleep(pollMs);

    const current = await readRepo();
    if (!current) {
      throw new Error(`Gitea's import of ${location} failed: the repository is gone.`);
    }
    if (!isGiteaImportRunning(current)) {
      console.log(`Gitea finished importing ${location}.`);
      return current;
    }
  }

  throw new Error(
    `Gitea is still importing ${location} after ${minutes} minutes. Retry once it has finished. ` +
      `A failed import stays in this state, so if it has looked like this for hours, ` +
      `delete the repository in Gitea and retry.`
  );
}
