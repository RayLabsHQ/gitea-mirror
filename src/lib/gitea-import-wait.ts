/**
 * Waiting for an import Gitea is still running (#496).
 *
 * The migrate call stays open until the clone is done, so a reverse proxy can
 * time out on it while Gitea carries on. A retry then finds the repository
 * already there, but Gitea creates the repository first and adds its mirror
 * record only after the clone. Until then the API answers `empty: true` with an
 * empty `mirror_interval`, mirror-sync refuses it as "not a mirror", and none of
 * the tags a release needs exist yet. Seen on Gitea 1.24.7.
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
 * Resolves once the import has finished. Throws when Gitea dropped the repository,
 * which is what a failed import does, or when the wait runs out; the row then
 * fails with that message and a retry picks it up from there.
 */
export async function waitForGiteaImport({
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
  initial: GiteaImportState;
  readRepo: () => Promise<GiteaImportState | null>;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  if (!isGiteaImportRunning(initial)) {
    return;
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
      return;
    }
  }

  throw new Error(`Gitea is still importing ${location} after ${minutes} minutes. Retry once it has finished.`);
}
