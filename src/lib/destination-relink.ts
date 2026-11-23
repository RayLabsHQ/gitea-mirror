/**
 * Repoint a repository row at the configured Gitea or Forgejo address.
 *
 * Every repository row records the destination URL it was mirrored to, and
 * assertRepositoryMatchesConfiguredDestination refuses a row whose recorded
 * URL differs from the configured one, so a token is never used against a
 * repository on another server. Nothing ever updated the recorded URL, so
 * when a server only moved to a new address every existing row was refused
 * for good, although the mirrors were all in place.
 *
 * The rule here: a row is repointed when the configured destination already
 * holds, at the row's recorded location or at the location the mirror
 * strategy gives, a pull mirror of the row's source that the configured
 * token can push to. The row then records that location as well, so the
 * sync acts on the verified repository. That is the lock dialog's "fails
 * until they exist on the new server". Only those two locations are probed
 * (no server-wide search, which would also see other accounts' mirrors), so
 * a row that does not match costs at most two lookups per run. Anything
 * else keeps the guard's refusal; push targets on either side are never
 * repointed.
 */
import type { Config } from "@/types/config";
import type { Repository } from "@/lib/db/schema";
import type { GiteaRepoInfo } from "@/lib/gitea-enhanced";
import { db, repositories } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  assertRepositoryMatchesConfiguredDestination,
  resolveDestinationIdentity,
} from "./destination-connection";
import {
  describeDestination,
  getRepositoryDestination,
  isPushDestinationKind,
  isRepositoryOnConfiguredDestination,
} from "./destination-kinds";
import { repositoryDestinationColumns } from "./repo-utils";
import { isMirrorOfSource } from "./utils/mirror-source-match";

type RelinkColumns = ReturnType<typeof repositoryDestinationColumns> & { mirroredLocation: string };

export interface RelinkLocation {
  owner: string;
  repoName: string;
}

export interface RelinkDependencies {
  /** Reads one repository on the configured destination; null when it does not exist. */
  getRepoInfo?: (args: {
    config: Partial<Config>;
    owner: string;
    repoName: string;
  }) => Promise<GiteaRepoInfo | null>;
  /** Stores the new destination columns and the verified location on the row. */
  saveDestination?: (repositoryId: string, columns: RelinkColumns) => Promise<void>;
}

async function readRepoInfo(args: {
  config: Partial<Config>;
  owner: string;
  repoName: string;
}): Promise<GiteaRepoInfo | null> {
  const { getGiteaRepoInfo } = await import("@/lib/gitea-enhanced");
  return getGiteaRepoInfo(args);
}

// Where the row points, and nothing else: this is a correction, not
// activity, so updatedAt (which the in-flight claim reads) stays as is.
async function saveDestinationColumns(repositoryId: string, columns: RelinkColumns): Promise<void> {
  await db.update(repositories).set(columns).where(eq(repositories.id, repositoryId));
}

function parseLocation(location: string | null | undefined): RelinkLocation | null {
  const value = (location ?? "").trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  const owner = value.slice(0, slash).trim();
  const repoName = value.slice(slash + 1).trim();
  return owner && repoName ? { owner, repoName } : null;
}

/** A pull mirror of this source that the configured token may write to. */
function isWritableMirrorOfSource(info: GiteaRepoInfo | null, cloneUrl: string | null | undefined): boolean {
  if (!isMirrorOfSource(info, cloneUrl)) return false;
  const permissions = info?.permissions;
  return permissions?.push === true || permissions?.admin === true;
}

/**
 * Make sure a row may be mirrored or synced on the configured Gitea or
 * Forgejo destination, repointing it when the rule above holds. Throws the
 * guard's error when it does not, or a lookup error when the destination
 * could not be asked.
 *
 * `resolveOwner` gives the owner the current strategy expects; it is only
 * called when the recorded URL differs and the recorded location does not
 * hold the mirror. On a relink the row object is updated in place, so later
 * guards and lookups in the same run see the new URL and location.
 *
 * Returns the verified location when the row was repointed, null otherwise.
 */
export async function ensureRepositoryOnConfiguredDestination(
  {
    repository,
    config,
    resolveOwner,
  }: {
    repository: Repository;
    config: Partial<Config>;
    resolveOwner: () => Promise<string> | string;
  },
  deps: RelinkDependencies = {}
): Promise<RelinkLocation | null> {
  const destination = resolveDestinationIdentity(config);
  if (isRepositoryOnConfiguredDestination(repository, destination)) return null;

  const recorded = getRepositoryDestination(repository);
  const pullOnBothSides =
    !isPushDestinationKind(recorded.provider) && !isPushDestinationKind(destination.provider);

  if (pullOnBothSides && repository.id && destination.url) {
    const getRepoInfo = deps.getRepoInfo ?? readRepoInfo;
    const probed = new Set<string>();
    let lookupError: unknown = null;

    // The recorded location first; the strategy owner is only resolved when
    // that one does not hold the mirror.
    const probe = async (candidate: RelinkLocation | null): Promise<RelinkLocation | null> => {
      if (!candidate) return null;
      const key = `${candidate.owner}/${candidate.repoName}`.toLowerCase();
      if (probed.has(key)) return null;
      probed.add(key);
      try {
        const info = await getRepoInfo({ config, owner: candidate.owner, repoName: candidate.repoName });
        return isWritableMirrorOfSource(info, repository.cloneUrl) ? candidate : null;
      } catch (error) {
        lookupError = error;
        return null;
      }
    };

    const verified =
      (await probe(parseLocation(repository.mirroredLocation))) ??
      (await probe(parseLocation(`${(await resolveOwner()).trim()}/${repository.name}`)));

    if (verified) {
      // The verified location is recorded too, so the sync and the mirror
      // paths, which try the recorded location first, act on this repository
      // and never on one that was rejected above.
      const columns: RelinkColumns = {
        ...repositoryDestinationColumns(destination),
        mirroredLocation: `${verified.owner}/${verified.repoName}`,
      };
      await (deps.saveDestination ?? saveDestinationColumns)(repository.id, columns);
      Object.assign(repository, columns);
      console.log(
        `[Destination] ${repository.fullName} was recorded on ${describeDestination(recorded)}; ` +
          `${describeDestination(destination)} has a pull mirror of its source at ` +
          `${columns.mirroredLocation}, so the row now points at the configured destination.`
      );
      return verified;
    }

    // An unreachable server or a rejected token is not a reason to remove
    // and mirror again; say what actually went wrong.
    if (lookupError) {
      throw new Error(
        `Repository ${repository.fullName} is recorded on ${describeDestination(recorded)}, and ` +
          `${describeDestination(destination)} could not be checked for its mirror: ` +
          (lookupError instanceof Error ? lookupError.message : String(lookupError))
      );
    }
  }

  assertRepositoryMatchesConfiguredDestination({ repository, config });
  return null;
}
