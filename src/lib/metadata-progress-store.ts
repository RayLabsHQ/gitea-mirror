/**
 * Write the progress of an unfinished issues or pull request pass as soon
 * as it is known (#449 follow-up). A rate limit ends the sync with a throw,
 * before the usual metadata write at the end of it, so without this the
 * next run would start the pass over from the first item.
 */

import { eq } from "drizzle-orm";
import { db, repositories } from "./db";
import {
  serializeRepositoryMetadataState,
  type MetadataPassProgress,
  type MetadataPassProgressByKind,
  type RepositoryMetadataState,
} from "./metadata-state";

export async function persistMetadataPassProgress(
  repositoryId: string | null | undefined,
  metadataState: RepositoryMetadataState,
  kind: keyof MetadataPassProgressByKind,
  progress: MetadataPassProgress | undefined
): Promise<void> {
  if (progress) {
    metadataState.passProgress[kind] = progress;
  } else {
    delete metadataState.passProgress[kind];
  }
  if (!repositoryId) return;

  try {
    await db
      .update(repositories)
      .set({ metadata: serializeRepositoryMetadataState(metadataState) })
      .where(eq(repositories.id, repositoryId));
  } catch (error) {
    // The in-memory state still carries it for the write at the end of a
    // sync that does not throw; only a rate limited run loses it.
    console.warn(
      `[Metadata] Could not save ${kind} pass progress: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
