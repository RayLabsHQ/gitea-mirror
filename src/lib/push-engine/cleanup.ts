/**
 * What the cleanup service and the delete routes need from the push engine:
 * archive or delete the repository on the target, and drop the bare clone
 * once its database row is gone.
 */
import type { Config, Repository } from "@/lib/db/schema";
import { createPushTargetFromConfig } from "@/lib/destination-connection";
import { getGiteaRepoOwnerAsync } from "@/lib/gitea";
import { removeClone } from "./engine";
import { parseMirroredLocation } from "./mirror";
import { clonePathForRepository, type CloneRepositoryFields } from "./paths";

type TargetRepositoryRow = CloneRepositoryFields & {
  mirroredLocation?: string | null;
  fullName?: string;
} & Partial<Repository>;

/** Where a row's mirror lives on the target: the recorded location, else the strategy's answer. */
export async function resolvePushTargetLocation(
  config: Partial<Config>,
  repository: TargetRepositoryRow
): Promise<{ owner: string; name: string }> {
  const recorded = parseMirroredLocation(repository.mirroredLocation);
  if (recorded) return recorded;
  const owner = await getGiteaRepoOwnerAsync({ config, repository: repository as Repository });
  return { owner, name: repository.name };
}

export async function archiveOnPushTarget({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: TargetRepositoryRow;
}): Promise<void> {
  const target = createPushTargetFromConfig(config);
  const { owner, name } = await resolvePushTargetLocation(config, repository);
  await target.archiveRepository(owner, name);
}

export async function deleteOnPushTarget({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: TargetRepositoryRow;
}): Promise<void> {
  const target = createPushTargetFromConfig(config);
  const { owner, name } = await resolvePushTargetLocation(config, repository);
  await target.deleteRepository(owner, name);
  await removeCloneForRepository({ repository });
}

/** Drop the bare clone for a row. Safe to call when there is none. */
export async function removeCloneForRepository({
  repository,
}: {
  repository: CloneRepositoryFields;
}): Promise<void> {
  await removeClone(clonePathForRepository(repository));
}
