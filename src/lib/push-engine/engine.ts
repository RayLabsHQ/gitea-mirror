/**
 * The push engine proper: keep a bare clone of the source up to date and
 * push its branches and tags to the target.
 *
 * This module knows nothing about the database. It takes a plan (where the
 * clone lives, how to reach the source, which target to push to) and
 * returns what happened, so it can be exercised with local file:// remotes.
 *
 * Only refs/heads and refs/tags travel. Hosts refuse writes to their own
 * namespaces (refs/pull on GitHub, refs/merge-requests on GitLab), so a
 * literal `push --mirror` of a clone that carried them would fail; the
 * explicit refspecs below give the same result for everything a host lets
 * us write. Force and prune are on, so a rewritten or deleted branch on the
 * source is rewritten or deleted on the target.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { GitCommandError, parseRefList, runGit, type GitCredentials } from "./git";
import { getPushLimiter } from "./limiter";
import { lockPathFor, withCloneLock } from "./lock";
import type { PushTarget, PushTargetRepository } from "./targets/types";

export const MIRROR_REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"] as const;

/** Refs per push when the single mirror push is refused for size. */
export const PUSH_BATCH_SIZE = 50;

export interface PushMirrorPlan {
  clonePath: string;
  sourceCloneUrl: string;
  sourceCredentials: GitCredentials | null;
  target: PushTarget;
  owner: string;
  name: string;
  isPrivate: boolean;
  description?: string | null;
  defaultBranch?: string | null;
  lockStaleAfterMs?: number;
  /** Wait between pushes into a repository this run just created; defaults to READINESS_DELAY_MS. */
  readinessDelayMs?: number;
  log?: (message: string) => void;
}

export interface PushMirrorOutcome {
  targetRepository: PushTargetRepository;
  /** True when this run created the bare clone. */
  cloned: boolean;
  refsBefore: Map<string, string>;
  refsAfter: Map<string, string>;
  /** Refs the fetch added, moved or removed in the clone. */
  changedRefs: number;
  /** False when the target already had everything. */
  pushed: boolean;
  /** Number of batched pushes used; 0 when the single push went through. */
  batches: number;
}

export async function runPushMirror(plan: PushMirrorPlan): Promise<PushMirrorOutcome> {
  return withCloneLock(plan.clonePath, () => getPushLimiter().run(() => execute(plan)), {
    staleAfterMs: plan.lockStaleAfterMs,
  });
}

async function execute(plan: PushMirrorPlan): Promise<PushMirrorOutcome> {
  const log = plan.log ?? (() => {});

  const { cloned, refsBefore } = await ensureClone(plan, log);
  const refsAfter = await listRefs(plan.clonePath);
  const changedRefs = countChanges(refsBefore, refsAfter);
  log(
    cloned
      ? `cloned ${refsAfter.size} refs from the source`
      : `fetched from the source: ${changedRefs} ref(s) changed, ${refsAfter.size} total`
  );

  const targetRepository = await plan.target.ensureRepository({
    owner: plan.owner,
    name: plan.name,
    isPrivate: plan.isPrivate,
    description: plan.description,
  });
  if (targetRepository.archived) {
    throw new Error(
      `${targetRepository.owner}/${targetRepository.name} is archived on ${plan.target.baseUrl}. Unarchive it there before mirroring into it.`
    );
  }
  if (targetRepository.created) {
    log(`created ${targetRepository.owner}/${targetRepository.name} on ${plan.target.baseUrl}`);
  }

  const { pushed, batches } = targetRepository.created
    ? await pushWhenReady(plan, targetRepository.pushUrl, refsAfter, log)
    : await pushAll(plan, targetRepository.pushUrl, refsAfter, log);
  log(pushed ? `pushed to ${targetRepository.htmlUrl}` : `${targetRepository.htmlUrl} was already up to date`);

  const wanted = plan.defaultBranch?.trim();
  if (
    wanted &&
    refsAfter.has(`refs/heads/${wanted}`) &&
    (targetRepository.created || pushed) &&
    plan.target.setDefaultBranch
  ) {
    try {
      await plan.target.setDefaultBranch(targetRepository.owner, targetRepository.name, wanted);
    } catch (error) {
      log(`could not set the default branch to ${wanted}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { targetRepository, cloned, refsBefore, refsAfter, changedRefs, pushed, batches };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A usable bare clone has a HEAD and git agrees it is bare. */
export async function isHealthyBareClone(clonePath: string): Promise<boolean> {
  if (!(await pathExists(path.join(clonePath, "HEAD")))) return false;
  try {
    const { stdout } = await runGit(["-C", clonePath, "rev-parse", "--is-bare-repository"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function configureClone(plan: PushMirrorPlan): Promise<void> {
  const { clonePath, sourceCloneUrl } = plan;
  await runGit(["-C", clonePath, "remote", "set-url", "origin", sourceCloneUrl]);
  // Exactly two fetch refspecs, whatever an earlier run left behind.
  await runGit(["-C", clonePath, "config", "--replace-all", "remote.origin.fetch", MIRROR_REFSPECS[0]]);
  await runGit(["-C", clonePath, "config", "--add", "remote.origin.fetch", MIRROR_REFSPECS[1]]);
}

async function ensureClone(
  plan: PushMirrorPlan,
  log: (message: string) => void
): Promise<{ cloned: boolean; refsBefore: Map<string, string> }> {
  const { clonePath, sourceCloneUrl, sourceCredentials } = plan;

  if (!(await isHealthyBareClone(clonePath))) {
    if (await pathExists(clonePath)) {
      log(`removing a half written clone at ${clonePath}`);
      await rm(clonePath, { recursive: true, force: true });
    }
    await mkdir(path.dirname(clonePath), { recursive: true });
    await runGit(["clone", "--bare", "--quiet", "--no-tags", sourceCloneUrl, clonePath], {
      credentials: sourceCredentials,
    });
    await configureClone(plan);
    // A bare clone already carries the branches; the configured refspecs
    // bring the tags and prune anything the source no longer has.
    await runGit(["-C", clonePath, "fetch", "--quiet", "--prune", "--prune-tags", "--no-recurse-submodules", "origin"], {
      credentials: sourceCredentials,
    });
    return { cloned: true, refsBefore: new Map() };
  }

  await configureClone(plan);
  const refsBefore = await listRefs(clonePath);
  await runGit(["-C", clonePath, "fetch", "--quiet", "--prune", "--prune-tags", "--no-recurse-submodules", "origin"], {
    credentials: sourceCredentials,
  });
  return { cloned: false, refsBefore };
}

export async function listRefs(clonePath: string): Promise<Map<string, string>> {
  const { stdout } = await runGit([
    "-C",
    clonePath,
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads",
    "refs/tags",
  ]);
  return parseRefList(stdout);
}

export function countChanges(before: Map<string, string>, after: Map<string, string>): number {
  let changed = 0;
  for (const [ref, sha] of after) {
    if (before.get(ref) !== sha) changed += 1;
  }
  for (const ref of before.keys()) {
    if (!after.has(ref)) changed += 1;
  }
  return changed;
}

/** Porcelain push output: one line per ref, first character is the status flag. */
export function parsePushPorcelain(output: string): { updated: number; upToDate: number; rejected: string[] } {
  let updated = 0;
  let upToDate = 0;
  const rejected: string[] = [];
  for (const line of output.split("\n")) {
    if (!line || line.startsWith("To ") || line.startsWith("Done")) continue;
    const flag = line[0];
    const refs = line.slice(1).split("\t")[1] ?? "";
    if (flag === "=") upToDate += 1;
    else if (flag === "!") rejected.push(refs || line.trim());
    else if (" +-*".includes(flag)) updated += 1;
  }
  return { updated, upToDate, rejected };
}

const NON_RETRYABLE_PUSH =
  /authentication failed|could not read username|permission|denied|not found|repository .* does not exist|does not appear to be a git repository|could not read from remote repository|403|401|archived|read-only/i;

/** Failures that batching cannot help with: bad credentials, missing repository. */
export function isRetryableInBatches(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  return !NON_RETRYABLE_PUSH.test(`${error.message}\n${error.stderr}`);
}

async function pushAll(
  plan: PushMirrorPlan,
  pushUrl: string,
  refs: Map<string, string>,
  log: (message: string) => void
): Promise<{ pushed: boolean; batches: number }> {
  const credentials = plan.target.pushCredentials();
  const { clonePath } = plan;

  try {
    const { stdout } = await runGit(
      ["-C", clonePath, "push", "--no-progress", "--prune", "--porcelain", pushUrl, ...MIRROR_REFSPECS],
      { credentials }
    );
    const parsed = parsePushPorcelain(stdout);
    return { pushed: parsed.updated > 0, batches: 0 };
  } catch (error) {
    if (!isRetryableInBatches(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    log(`single push was refused (${reason}); retrying in batches of ${PUSH_BATCH_SIZE} refs`);
  }

  const heads = [...refs.keys()].filter((ref) => ref.startsWith("refs/heads/"));
  const tags = [...refs.keys()].filter((ref) => ref.startsWith("refs/tags/"));
  let batches = 0;
  for (const group of [heads, tags]) {
    for (let i = 0; i < group.length; i += PUSH_BATCH_SIZE) {
      const chunk = group.slice(i, i + PUSH_BATCH_SIZE).map((ref) => `+${ref}:${ref}`);
      batches += 1;
      try {
        await runGit(["-C", clonePath, "push", "--no-progress", "--porcelain", pushUrl, ...chunk], { credentials });
      } catch (error) {
        throw new Error(
          `Pushing to ${pushUrl.replace(/\/\/[^@]*@/, "//")} failed even in batches of ${PUSH_BATCH_SIZE} refs (batch ${batches}): ${
            error instanceof Error ? error.message : String(error)
          }. The target may limit the size of a single push; try again later or reduce the repository first.`
        );
      }
    }
  }
  // The batches only added and updated refs; a final prune removes what the source dropped.
  batches += 1;
  await runGit(["-C", clonePath, "push", "--no-progress", "--prune", "--porcelain", pushUrl, ...MIRROR_REFSPECS], {
    credentials,
  });
  return { pushed: true, batches };
}

/** How a host answers a push that arrives before a just created repository is ready. */
const TARGET_NOT_READY = /not found|could not be found|does not exist|does not appear to be a git repository/i;
export const READINESS_ATTEMPTS = 6;
export const READINESS_DELAY_MS = 2000;

/** True for the transient "repository not found" a host returns right after creating it. */
export function isTargetNotReady(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  return TARGET_NOT_READY.test(`${error.message}\n${error.stderr}`);
}

/**
 * First push into a repository this run created. GitLab (and sometimes
 * GitHub) answer "not found" for a second or two after the create call
 * returns, so a not-found here is retried a few times before it counts.
 */
async function pushWhenReady(
  plan: PushMirrorPlan,
  pushUrl: string,
  refs: Map<string, string>,
  log: (message: string) => void
): Promise<{ pushed: boolean; batches: number }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await pushAll(plan, pushUrl, refs, log);
    } catch (error) {
      if (attempt >= READINESS_ATTEMPTS || !isTargetNotReady(error)) throw error;
      const delay = plan.readinessDelayMs ?? READINESS_DELAY_MS;
      log(`the new repository is not ready for pushes yet (attempt ${attempt}); retrying in ${delay / 1000}s`);
      await Bun.sleep(delay);
    }
  }
}

/** Remove a repository's bare clone and its lock file. */
export async function removeClone(clonePath: string): Promise<void> {
  await rm(clonePath, { recursive: true, force: true });
  await rm(lockPathFor(clonePath), { force: true });
}
