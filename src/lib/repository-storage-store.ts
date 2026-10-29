/**
 * Write the release asset totals the retention pass measured (#479). The
 * release pass has no write of its own at the end, so it records them here.
 */

import { eq } from "drizzle-orm";
import { db, repositories } from "./db";
import type { ReleaseAssetSummary } from "./repository-storage";

/** Never throws: a failed write must not fail the release pass. */
export async function recordReleaseAssetStorage(
  repositoryId: string | null | undefined,
  summary: ReleaseAssetSummary
): Promise<void> {
  if (!repositoryId) return;

  try {
    await db
      .update(repositories)
      .set({
        releaseAssetsSize: summary.bytes,
        releaseAssetsCount: summary.count,
        storageCheckedAt: new Date(),
      })
      .where(eq(repositories.id, repositoryId));
  } catch (error) {
    console.warn(
      `[Storage] Could not record release asset sizes for repository ${repositoryId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
