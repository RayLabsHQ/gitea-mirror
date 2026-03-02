import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  detectForcePushes,
  getForcePushAction,
  type BranchRef,
  type ForcePushDetectionResult,
} from "./force-push-detection";

// ─── detectForcePushes ───────────────────────────────────────────────────────

describe("detectForcePushes", () => {
  test("returns no destructive changes when both sides are identical", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa111" },
      { name: "dev", sha: "bbb222" },
    ];
    const github: BranchRef[] = [
      { name: "main", sha: "aaa111" },
      { name: "dev", sha: "bbb222" },
    ];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(false);
    expect(result.forcePushDetected).toBe(false);
    expect(result.affectedBranches).toHaveLength(0);
    expect(result.normalBranches).toEqual(
      expect.arrayContaining(["main", "dev"]),
    );
    expect(result.newBranches).toHaveLength(0);
    expect(result.deletedBranches).toHaveLength(0);
  });

  test("detects force-push when SHAs differ on the same branch", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "old-sha-111" },
      { name: "dev", sha: "same-sha" },
    ];
    const github: BranchRef[] = [
      { name: "main", sha: "new-sha-222" },
      { name: "dev", sha: "same-sha" },
    ];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(true);
    expect(result.forcePushDetected).toBe(true);
    expect(result.affectedBranches).toHaveLength(1);
    expect(result.affectedBranches[0]).toEqual({
      branch: "main",
      giteaSha: "old-sha-111",
      githubSha: "new-sha-222",
    });
    expect(result.normalBranches).toEqual(["dev"]);
    expect(result.deletedBranches).toHaveLength(0);
  });

  test("detects multiple force-pushed branches", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "dev", sha: "bbb" },
      { name: "release", sha: "ccc" },
    ];
    const github: BranchRef[] = [
      { name: "main", sha: "xxx" },
      { name: "dev", sha: "yyy" },
      { name: "release", sha: "ccc" },
    ];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(true);
    expect(result.forcePushDetected).toBe(true);
    expect(result.affectedBranches).toHaveLength(2);
    const affectedNames = result.affectedBranches.map((b) => b.branch);
    expect(affectedNames).toContain("main");
    expect(affectedNames).toContain("dev");
    expect(result.normalBranches).toEqual(["release"]);
  });

  test("identifies new branches (exist on GitHub but not Gitea)", () => {
    const gitea: BranchRef[] = [{ name: "main", sha: "aaa" }];
    const github: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "feature-x", sha: "fff" },
    ];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(false);
    expect(result.forcePushDetected).toBe(false);
    expect(result.newBranches).toEqual(["feature-x"]);
    expect(result.normalBranches).toEqual(["main"]);
    expect(result.deletedBranches).toHaveLength(0);
  });

  // ─── Branch deletion detection ─────────────────────────────────────────

  test("detects deleted branches as destructive changes", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "old-branch", sha: "ooo" },
    ];
    const github: BranchRef[] = [{ name: "main", sha: "aaa" }];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(true);
    // forcePushDetected is false — no SHA mismatch, only a deletion
    expect(result.forcePushDetected).toBe(false);
    expect(result.deletedBranches).toEqual(["old-branch"]);
    expect(result.normalBranches).toEqual(["main"]);
    expect(result.affectedBranches).toHaveLength(0);
  });

  test("detects multiple deleted branches", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "feature-a", sha: "bbb" },
      { name: "feature-b", sha: "ccc" },
    ];
    const github: BranchRef[] = [{ name: "main", sha: "aaa" }];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(true);
    expect(result.deletedBranches).toEqual(
      expect.arrayContaining(["feature-a", "feature-b"]),
    );
    expect(result.deletedBranches).toHaveLength(2);
  });

  test("excludes backup branches from deletion detection", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "_main_backup_2026-02-25T18-34-22-123Z", sha: "old-aaa" },
      { name: "_dev_backup_2026-02-20T10-00-00-000Z", sha: "old-bbb" },
      { name: "real-branch", sha: "rrr" },
    ];
    const github: BranchRef[] = [{ name: "main", sha: "aaa" }];

    const result = detectForcePushes(gitea, github);

    // Only real-branch should be flagged, not the backup branches
    expect(result.deletedBranches).toEqual(["real-branch"]);
    expect(result.deletedBranches).toHaveLength(1);
    expect(result.destructiveChangesDetected).toBe(true);
  });

  test("does not flag backup branches even when they match _*_backup_ pattern", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "_release_backup_2026-01-01T00-00-00-000Z", sha: "xxx" },
    ];
    const github: BranchRef[] = [{ name: "main", sha: "aaa" }];

    const result = detectForcePushes(gitea, github);

    expect(result.deletedBranches).toHaveLength(0);
    expect(result.destructiveChangesDetected).toBe(false);
  });

  // ─── Edge cases ────────────────────────────────────────────────────────

  test("handles empty Gitea branches (first mirror)", () => {
    const gitea: BranchRef[] = [];
    const github: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "dev", sha: "bbb" },
    ];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(false);
    expect(result.forcePushDetected).toBe(false);
    expect(result.newBranches).toEqual(expect.arrayContaining(["main", "dev"]));
    expect(result.affectedBranches).toHaveLength(0);
    expect(result.deletedBranches).toHaveLength(0);
  });

  test("handles empty GitHub branches (all branches deleted upstream)", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "dev", sha: "bbb" },
    ];
    const github: BranchRef[] = [];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(true);
    expect(result.forcePushDetected).toBe(false);
    expect(result.deletedBranches).toEqual(
      expect.arrayContaining(["main", "dev"]),
    );
  });

  test("handles both sides empty", () => {
    const result = detectForcePushes([], []);

    expect(result.destructiveChangesDetected).toBe(false);
    expect(result.forcePushDetected).toBe(false);
    expect(result.affectedBranches).toHaveLength(0);
    expect(result.normalBranches).toHaveLength(0);
    expect(result.newBranches).toHaveLength(0);
    expect(result.deletedBranches).toHaveLength(0);
  });

  test("complex scenario: mix of force-push, deletion, new, and normal", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "dev", sha: "bbb" },
      { name: "old-feature", sha: "ccc" },
      { name: "stable", sha: "ddd" },
      { name: "_old-feature_backup_2026-01-01T00-00-00-000Z", sha: "old-ccc" },
    ];
    const github: BranchRef[] = [
      { name: "main", sha: "xxx" }, // force-push
      { name: "dev", sha: "bbb" }, // normal
      { name: "new-feature", sha: "nnn" }, // new
      { name: "stable", sha: "ddd" }, // normal
    ];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(true);
    expect(result.forcePushDetected).toBe(true);
    expect(result.affectedBranches).toHaveLength(1);
    expect(result.affectedBranches[0].branch).toBe("main");
    expect(result.normalBranches).toEqual(
      expect.arrayContaining(["dev", "stable"]),
    );
    expect(result.newBranches).toEqual(["new-feature"]);
    // old-feature is deleted upstream; the backup branch is excluded
    expect(result.deletedBranches).toEqual(["old-feature"]);
  });

  test("destructiveChangesDetected is true with only deletions (no force-push)", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "feature-gone", sha: "fff" },
    ];
    const github: BranchRef[] = [{ name: "main", sha: "aaa" }];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(true);
    expect(result.forcePushDetected).toBe(false);
    expect(result.affectedBranches).toHaveLength(0);
    expect(result.deletedBranches).toEqual(["feature-gone"]);
  });

  test("destructiveChangesDetected is true with both force-push and deletion", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "abandoned", sha: "zzz" },
    ];
    const github: BranchRef[] = [{ name: "main", sha: "new-aaa" }];

    const result = detectForcePushes(gitea, github);

    expect(result.destructiveChangesDetected).toBe(true);
    expect(result.forcePushDetected).toBe(true);
    expect(result.affectedBranches).toHaveLength(1);
    expect(result.deletedBranches).toEqual(["abandoned"]);
  });
});

// ─── getForcePushAction ──────────────────────────────────────────────────────

describe("getForcePushAction", () => {
  test('defaults to "backup-branch" when no config is set', () => {
    expect(getForcePushAction({})).toBe("backup-branch");
  });

  test('defaults to "backup-branch" when giteaConfig exists but forcePushAction is absent', () => {
    expect(
      getForcePushAction({
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "tok",
          organization: "org",
          visibility: "public",
          starredReposOrg: "starred",
          preserveOrgStructure: false,
        },
      } as any),
    ).toBe("backup-branch");
  });

  test('defaults to "backup-branch" when giteaConfig exists but forcePushAction is absent', () => {
    expect(
      getForcePushAction({
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "tok",
          organization: "org",
          visibility: "public",
          starredReposOrg: "starred",
          preserveOrgStructure: false,
        },
      } as any),
    ).toBe("backup-branch");
  });

  test('returns "backup-branch" when explicitly configured', () => {
    expect(
      getForcePushAction({
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "tok",
          organization: "org",
          visibility: "public",
          starredReposOrg: "starred",
          preserveOrgStructure: false,
          forcePushAction: "backup-branch",
        },
      } as any),
    ).toBe("backup-branch");
  });

  test('returns "block" when configured', () => {
    expect(
      getForcePushAction({
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "tok",
          organization: "org",
          visibility: "public",
          starredReposOrg: "starred",
          preserveOrgStructure: false,
          forcePushAction: "block",
        },
      } as any),
    ).toBe("block");
  });

  test('returns "allow" when explicitly configured (opt-out of protection)', () => {
    expect(
      getForcePushAction({
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "tok",
          organization: "org",
          visibility: "public",
          starredReposOrg: "starred",
          preserveOrgStructure: false,
          forcePushAction: "allow",
        },
      } as any),
    ).toBe("allow");
  });
});
