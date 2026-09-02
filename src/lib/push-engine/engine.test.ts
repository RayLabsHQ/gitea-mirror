/**
 * The push engine against real git on local file:// remotes: a bare
 * "source", the engine's clone, and a bare "target" standing in for GitHub.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  countChanges,
  isHealthyBareClone,
  isRetryableInBatches,
  isTargetNotReady,
  listRefs,
  parsePushPorcelain,
  removeClone,
  runPushMirror,
  type PushMirrorPlan,
} from "./engine";
import { GitCommandError, gitSubcommand, runGit } from "./git";
import { getPushLimiter, resetPushLimiter } from "./limiter";
import { CloneLockedError, lockPathFor } from "./lock";
import type {
  EnsureRepositoryInput,
  PushTarget,
  PushTargetIdentity,
  PushTargetRepository,
} from "./targets/types";

const GIT_IDENTITY = ["-c", "user.name=Push Engine Test", "-c", "user.email=push@example.com"];

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A push target backed by bare repositories on disk. */
class LocalPushTarget implements PushTarget {
  readonly kind = "local" as const;
  readonly baseUrl: string;
  readonly archived = new Set<string>();
  readonly createdRepositories: string[] = [];
  readonly defaultBranches = new Map<string, string>();
  active = 0;
  maxActive = 0;

  constructor(
    private readonly root: string,
    private readonly ensureDelayMs = 0
  ) {
    this.baseUrl = `file://${root}`;
  }

  private dirFor(owner: string, name: string): string {
    return path.join(this.root, owner, `${name}.git`);
  }

  private describe(owner: string, name: string, created: boolean): PushTargetRepository {
    const dir = this.dirFor(owner, name);
    return {
      owner,
      name,
      pushUrl: `file://${dir}`,
      htmlUrl: `file://${dir}`,
      isPrivate: false,
      archived: this.archived.has(`${owner}/${name}`),
      created,
    };
  }

  pushCredentials() {
    return null;
  }

  async testConnection(): Promise<PushTargetIdentity> {
    return { login: "local" };
  }

  async getRepository(owner: string, name: string): Promise<PushTargetRepository | null> {
    if (!(await exists(path.join(this.dirFor(owner, name), "HEAD")))) return null;
    return this.describe(owner, name, false);
  }

  async ensureRepository(input: EnsureRepositoryInput): Promise<PushTargetRepository> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.ensureDelayMs > 0) await Bun.sleep(this.ensureDelayMs);
      const existing = await this.getRepository(input.owner, input.name);
      if (existing) return existing;
      const dir = this.dirFor(input.owner, input.name);
      await mkdir(path.dirname(dir), { recursive: true });
      await runGit(["init", "--bare", "--quiet", dir]);
      this.createdRepositories.push(`${input.owner}/${input.name}`);
      return this.describe(input.owner, input.name, true);
    } finally {
      this.active -= 1;
    }
  }

  async setDefaultBranch(owner: string, name: string, branch: string): Promise<void> {
    this.defaultBranches.set(`${owner}/${name}`, branch);
  }

  async archiveRepository(owner: string, name: string): Promise<void> {
    this.archived.add(`${owner}/${name}`);
  }

  async deleteRepository(owner: string, name: string): Promise<void> {
    await rm(this.dirFor(owner, name), { recursive: true, force: true });
  }
}

/**
 * A target whose freshly created repository only exists after the first
 * push attempt, the way GitLab answers "not found" for a moment after the
 * create call returns.
 */
class LazyPushTarget extends LocalPushTarget {
  pushAttempts = 0;
  private pending: { owner: string; name: string } | null = null;

  constructor(root: string) {
    super(root);
  }

  override async ensureRepository(input: EnsureRepositoryInput): Promise<PushTargetRepository> {
    const existing = await this.getRepository(input.owner, input.name);
    if (existing) return existing;
    this.pending = { owner: input.owner, name: input.name };
    const dir = path.join(this.baseUrl.replace(/^file:\/\//, ""), input.owner, `${input.name}.git`);
    return {
      owner: input.owner,
      name: input.name,
      pushUrl: `file://${dir}`,
      htmlUrl: `file://${dir}`,
      isPrivate: false,
      archived: false,
      created: true,
    };
  }

  override pushCredentials() {
    this.pushAttempts += 1;
    if (this.pushAttempts === 2 && this.pending) {
      const dir = path.join(this.baseUrl.replace(/^file:\/\//, ""), this.pending.owner, `${this.pending.name}.git`);
      // Create the repository between the first and the second attempt.
      Bun.spawnSync(["git", "init", "--bare", "--quiet", dir]);
      this.createdRepositories.push(`${this.pending.owner}/${this.pending.name}`);
      this.pending = null;
    }
    return null;
  }
}

interface SourceRepo {
  bareDir: string;
  workDir: string;
  url: string;
}

async function commitFile(workDir: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(path.join(workDir, file), content);
  await runGit(["-C", workDir, "add", "-A"]);
  await runGit([...GIT_IDENTITY, "-C", workDir, "commit", "--quiet", "-m", message]);
}

async function createSourceRepo(root: string, name: string): Promise<SourceRepo> {
  const bareDir = path.join(root, `${name}-source.git`);
  const workDir = path.join(root, `${name}-work`);
  await runGit(["init", "--bare", "--quiet", "--initial-branch=main", bareDir]);
  await runGit(["init", "--quiet", "--initial-branch=main", workDir]);
  await commitFile(workDir, "README.md", "hello\n", "initial commit");
  await runGit(["-C", workDir, "checkout", "--quiet", "-b", "feature"]);
  await commitFile(workDir, "feature.txt", "feature\n", "feature work");
  await runGit(["-C", workDir, "checkout", "--quiet", "main"]);
  await runGit([...GIT_IDENTITY, "-C", workDir, "tag", "-a", "v1.0.0", "-m", "first release"]);
  await runGit(["-C", workDir, "remote", "add", "origin", bareDir]);
  await runGit(["-C", workDir, "push", "--quiet", "origin", "main", "feature", "--tags"]);
  return { bareDir, workDir, url: `file://${bareDir}` };
}

let root: string;
let target: LocalPushTarget;

function planFor(source: SourceRepo, name: string, overrides: Partial<PushMirrorPlan> = {}): PushMirrorPlan {
  return {
    clonePath: path.join(root, "mirrors", "example.test", "acme", `${name}.git`),
    sourceCloneUrl: source.url,
    sourceCredentials: null,
    target,
    owner: "acme",
    name,
    isPrivate: false,
    description: "engine test",
    defaultBranch: "main",
    ...overrides,
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "push-engine-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  target = new LocalPushTarget(path.join(root, "targets"));
  resetPushLimiter(2);
});

describe("runPushMirror", () => {
  test("first run clones the source, creates the target and pushes every branch and tag", async () => {
    const source = await createSourceRepo(root, "first");
    const outcome = await runPushMirror(planFor(source, "first"));

    expect(outcome.cloned).toBe(true);
    expect(outcome.pushed).toBe(true);
    expect(outcome.batches).toBe(0);
    expect(outcome.targetRepository.created).toBe(true);
    expect(target.createdRepositories).toEqual(["acme/first"]);

    const sourceRefs = await listRefs(source.bareDir);
    const targetRefs = await listRefs(path.join(root, "targets", "acme", "first.git"));
    expect([...targetRefs.entries()].sort()).toEqual([...sourceRefs.entries()].sort());
    expect(targetRefs.has("refs/heads/main")).toBe(true);
    expect(targetRefs.has("refs/heads/feature")).toBe(true);
    expect(targetRefs.has("refs/tags/v1.0.0")).toBe(true);
    expect(target.defaultBranches.get("acme/first")).toBe("main");

    // No lock is left behind and the clone is a bare repository.
    const clonePath = planFor(source, "first").clonePath;
    expect(await exists(lockPathFor(clonePath))).toBe(false);
    expect(await isHealthyBareClone(clonePath)).toBe(true);
  });

  test("a second run fetches the new commit and tag and pushes only the change; a third run is a no-op", async () => {
    const source = await createSourceRepo(root, "incremental");
    const plan = planFor(source, "incremental");
    await runPushMirror(plan);

    await commitFile(source.workDir, "CHANGELOG.md", "v2\n", "second commit");
    await runGit([...GIT_IDENTITY, "-C", source.workDir, "tag", "v2.0.0"]);
    await runGit(["-C", source.workDir, "push", "--quiet", "origin", "main", "--tags"]);

    const second = await runPushMirror(plan);
    expect(second.cloned).toBe(false);
    expect(second.changedRefs).toBe(2);
    expect(second.pushed).toBe(true);
    expect(second.targetRepository.created).toBe(false);

    const targetRefs = await listRefs(path.join(root, "targets", "acme", "incremental.git"));
    const sourceRefs = await listRefs(source.bareDir);
    expect(targetRefs.get("refs/heads/main")).toBe(sourceRefs.get("refs/heads/main"));
    expect(targetRefs.has("refs/tags/v2.0.0")).toBe(true);

    const third = await runPushMirror(plan);
    expect(third.changedRefs).toBe(0);
    expect(third.pushed).toBe(false);
  });

  test("a branch deleted on the source is pruned from the clone and the target", async () => {
    const source = await createSourceRepo(root, "prune");
    const plan = planFor(source, "prune");
    await runPushMirror(plan);

    await runGit(["-C", source.workDir, "push", "--quiet", "origin", "--delete", "feature"]);
    const outcome = await runPushMirror(plan);

    expect(outcome.changedRefs).toBe(1);
    expect(outcome.refsAfter.has("refs/heads/feature")).toBe(false);
    const targetRefs = await listRefs(path.join(root, "targets", "acme", "prune.git"));
    expect(targetRefs.has("refs/heads/feature")).toBe(false);
    expect(targetRefs.has("refs/heads/main")).toBe(true);
  });

  test("a force push on the source is replicated to the target", async () => {
    const source = await createSourceRepo(root, "force");
    const plan = planFor(source, "force");
    await runPushMirror(plan);
    const before = (await listRefs(source.bareDir)).get("refs/heads/main");

    await runGit([...GIT_IDENTITY, "-C", source.workDir, "commit", "--quiet", "--amend", "-m", "rewritten history"]);
    await runGit(["-C", source.workDir, "push", "--quiet", "--force", "origin", "main"]);
    const after = (await listRefs(source.bareDir)).get("refs/heads/main");
    expect(after).not.toBe(before);

    const outcome = await runPushMirror(plan);
    expect(outcome.pushed).toBe(true);
    const targetRefs = await listRefs(path.join(root, "targets", "acme", "force.git"));
    expect(targetRefs.get("refs/heads/main")).toBe(after);
  });

  test("pull request refs on the source never reach the clone or the target", async () => {
    const source = await createSourceRepo(root, "hidden-refs");
    const mainSha = (await listRefs(source.bareDir)).get("refs/heads/main")!;
    await runGit(["-C", source.bareDir, "update-ref", "refs/pull/1/head", mainSha]);

    const plan = planFor(source, "hidden-refs");
    const outcome = await runPushMirror(plan);
    const { stdout } = await runGit(["-C", plan.clonePath, "for-each-ref", "--format=%(refname)"]);
    expect(stdout).not.toContain("refs/pull/");
    expect([...outcome.refsAfter.keys()].some((ref) => ref.startsWith("refs/pull/"))).toBe(false);
    const { stdout: targetOut } = await runGit([
      "-C",
      path.join(root, "targets", "acme", "hidden-refs.git"),
      "for-each-ref",
      "--format=%(refname)",
    ]);
    expect(targetOut).not.toContain("refs/pull/");
  });

  test("a stale lock is taken over, a live lock is refused", async () => {
    const source = await createSourceRepo(root, "locks");
    const plan = planFor(source, "locks");
    const lockPath = lockPathFor(plan.clonePath);
    await mkdir(path.dirname(lockPath), { recursive: true });

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: 1, takenAt: twoHoursAgo }));
    const outcome = await runPushMirror(plan);
    expect(outcome.cloned).toBe(true);
    expect(await exists(lockPath)).toBe(false);

    await writeFile(lockPath, JSON.stringify({ pid: 1, takenAt: new Date().toISOString() }));
    await expect(runPushMirror(plan)).rejects.toBeInstanceOf(CloneLockedError);
    await rm(lockPath, { force: true });
  });

  test("a half written clone directory is removed and cloned again", async () => {
    const source = await createSourceRepo(root, "half");
    const plan = planFor(source, "half");
    await mkdir(plan.clonePath, { recursive: true });
    await writeFile(path.join(plan.clonePath, "garbage"), "not a repository");

    const outcome = await runPushMirror(plan);
    expect(outcome.cloned).toBe(true);
    expect(await exists(path.join(plan.clonePath, "garbage"))).toBe(false);
    expect(await isHealthyBareClone(plan.clonePath)).toBe(true);

    await removeClone(plan.clonePath);
    expect(await exists(plan.clonePath)).toBe(false);
  });

  test("the global limit caps how many pushes run at once", async () => {
    const slowTarget = new LocalPushTarget(path.join(root, "slow-targets"), 120);
    target = slowTarget;
    const a = await createSourceRepo(root, "limit-a");
    const b = await createSourceRepo(root, "limit-b");

    resetPushLimiter(1);
    await Promise.all([runPushMirror(planFor(a, "limit-a")), runPushMirror(planFor(b, "limit-b"))]);
    expect(slowTarget.maxActive).toBe(1);
    expect(getPushLimiter().inFlight).toBe(0);

    slowTarget.maxActive = 0;
    resetPushLimiter(2);
    await Promise.all([runPushMirror(planFor(a, "limit-a")), runPushMirror(planFor(b, "limit-b"))]);
    expect(slowTarget.maxActive).toBe(2);
  });

  test("an archived target repository is refused before anything is pushed", async () => {
    const source = await createSourceRepo(root, "archived");
    const plan = planFor(source, "archived");
    await runPushMirror(plan);
    await target.archiveRepository("acme", "archived");

    await expect(runPushMirror(plan)).rejects.toThrow(/archived/);
  });
});

describe("helpers", () => {
  test("parsePushPorcelain counts updates and up-to-date refs and lists rejections", () => {
    const output = [
      "To file:///tmp/target.git",
      "=\trefs/heads/main:refs/heads/main\t[up to date]",
      "*\trefs/tags/v2:refs/tags/v2\t[new tag]",
      "+\trefs/heads/dev:refs/heads/dev\tabc...def (forced update)",
      "-\t:refs/heads/old\t[deleted]",
      "!\trefs/heads/locked:refs/heads/locked\t[remote rejected] (protected branch)",
      "Done",
    ].join("\n");
    const parsed = parsePushPorcelain(output);
    expect(parsed.updated).toBe(3);
    expect(parsed.upToDate).toBe(1);
    expect(parsed.rejected).toEqual(["refs/heads/locked:refs/heads/locked"]);
  });

  test("countChanges counts added, moved and removed refs", () => {
    const before = new Map([
      ["refs/heads/main", "a"],
      ["refs/heads/gone", "b"],
    ]);
    const after = new Map([
      ["refs/heads/main", "c"],
      ["refs/tags/v1", "d"],
    ]);
    expect(countChanges(before, after)).toBe(3);
    expect(countChanges(after, after)).toBe(0);
  });

  test("gitSubcommand names the subcommand, not the -C path or -c values", () => {
    expect(gitSubcommand(["-C", "/data/mirrors/x.git", "fetch", "--prune", "origin"])).toBe("fetch");
    expect(gitSubcommand(["-c", "core.askPass=", "-C", "/tmp/x", "push", "--mirror"])).toBe("push");
    expect(gitSubcommand(["clone", "--mirror", "https://example.com/a.git", "/tmp/a.git"])).toBe("clone");
    expect(gitSubcommand(["--version"])).toBe("");
  });

  test("a failing git command reports its subcommand in the error message", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "push-engine-nogit-"));
    try {
      await expect(runGit(["-C", dir, "fetch", "origin"])).rejects.toThrow(/^git fetch failed \(exit \d+\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a repository that is not ready right after creation is pushed on a later attempt", async () => {
    const lazy = new LazyPushTarget(path.join(root, "lazy-targets"));
    const source = await createSourceRepo(root, "lazy");
    const outcome = await runPushMirror(planFor(source, "lazy", { target: lazy, readinessDelayMs: 10 }));

    expect(outcome.targetRepository.created).toBe(true);
    expect(outcome.pushed).toBe(true);
    expect(lazy.pushAttempts).toBe(2);
    const targetRefs = await listRefs(path.join(root, "lazy-targets", "acme", "lazy.git"));
    expect(targetRefs.size).toBe(3);
  });

  test("isTargetNotReady only matches the transient not-found answers", () => {
    const notReady = new GitCommandError("git push failed", ["push"], 128, "remote: The project you were looking for could not be found or you don't have permission to view it.");
    const auth = new GitCommandError("git push failed", ["push"], 128, "fatal: Authentication failed for 'https://x'");
    expect(isTargetNotReady(notReady)).toBe(true);
    expect(isTargetNotReady(auth)).toBe(false);
    expect(isTargetNotReady(new Error("not found"))).toBe(false);
  });

  test("isRetryableInBatches keeps credential and missing repository failures out of the batch retry", () => {
    const auth = new GitCommandError("git push failed", ["push"], 128, "fatal: Authentication failed for 'https://x'");
    const missing = new GitCommandError("git push failed", ["push"], 128, "remote: Repository not found.");
    const size = new GitCommandError("git push failed", ["push"], 1, "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413");
    expect(isRetryableInBatches(auth)).toBe(false);
    expect(isRetryableInBatches(missing)).toBe(false);
    expect(isRetryableInBatches(size)).toBe(true);
    expect(isRetryableInBatches(new Error("plain"))).toBe(false);
  });
});
