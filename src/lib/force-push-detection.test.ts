import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  detectForcePushes,
  getForcePushAction,
  type BranchRef,
  type ForcePushDetectionResult,
} from "./force-push-detection";

// ─── detectForcePushes ───────────────────────────────────────────────────────

describe("detectForcePushes", () => {
  test("returns no force-push when both sides are identical", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa111" },
      { name: "dev", sha: "bbb222" },
    ];
    const github: BranchRef[] = [
      { name: "main", sha: "aaa111" },
      { name: "dev", sha: "bbb222" },
    ];

    const result = detectForcePushes(gitea, github);

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

    expect(result.forcePushDetected).toBe(true);
    expect(result.affectedBranches).toHaveLength(1);
    expect(result.affectedBranches[0]).toEqual({
      branch: "main",
      giteaSha: "old-sha-111",
      githubSha: "new-sha-222",
    });
    expect(result.normalBranches).toEqual(["dev"]);
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

    expect(result.forcePushDetected).toBe(false);
    expect(result.newBranches).toEqual(["feature-x"]);
    expect(result.normalBranches).toEqual(["main"]);
    expect(result.deletedBranches).toHaveLength(0);
  });

  test("identifies deleted branches (exist on Gitea but not GitHub)", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "old-branch", sha: "ooo" },
    ];
    const github: BranchRef[] = [{ name: "main", sha: "aaa" }];

    const result = detectForcePushes(gitea, github);

    expect(result.forcePushDetected).toBe(false);
    expect(result.deletedBranches).toEqual(["old-branch"]);
    expect(result.normalBranches).toEqual(["main"]);
  });

  test("handles empty Gitea branches (first mirror)", () => {
    const gitea: BranchRef[] = [];
    const github: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "dev", sha: "bbb" },
    ];

    const result = detectForcePushes(gitea, github);

    expect(result.forcePushDetected).toBe(false);
    expect(result.newBranches).toEqual(expect.arrayContaining(["main", "dev"]));
    expect(result.affectedBranches).toHaveLength(0);
  });

  test("handles empty GitHub branches (repo deleted upstream)", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "dev", sha: "bbb" },
    ];
    const github: BranchRef[] = [];

    const result = detectForcePushes(gitea, github);

    expect(result.forcePushDetected).toBe(false);
    expect(result.deletedBranches).toEqual(
      expect.arrayContaining(["main", "dev"]),
    );
  });

  test("handles both sides empty", () => {
    const result = detectForcePushes([], []);

    expect(result.forcePushDetected).toBe(false);
    expect(result.affectedBranches).toHaveLength(0);
    expect(result.normalBranches).toHaveLength(0);
    expect(result.newBranches).toHaveLength(0);
    expect(result.deletedBranches).toHaveLength(0);
  });

  test("complex scenario: mix of force-push, new, deleted, and normal", () => {
    const gitea: BranchRef[] = [
      { name: "main", sha: "aaa" },
      { name: "dev", sha: "bbb" },
      { name: "old-feature", sha: "ccc" },
      { name: "stable", sha: "ddd" },
    ];
    const github: BranchRef[] = [
      { name: "main", sha: "xxx" }, // force-push
      { name: "dev", sha: "bbb" }, // normal
      { name: "new-feature", sha: "nnn" }, // new
      { name: "stable", sha: "ddd" }, // normal
    ];

    const result = detectForcePushes(gitea, github);

    expect(result.forcePushDetected).toBe(true);
    expect(result.affectedBranches).toHaveLength(1);
    expect(result.affectedBranches[0].branch).toBe("main");
    expect(result.normalBranches).toEqual(
      expect.arrayContaining(["dev", "stable"]),
    );
    expect(result.newBranches).toEqual(["new-feature"]);
    expect(result.deletedBranches).toEqual(["old-feature"]);
  });
});

// ─── getForcePushAction ──────────────────────────────────────────────────────

describe("getForcePushAction", () => {
  test('returns "allow" when no config is set', () => {
    expect(getForcePushAction({})).toBe("allow");
  });

  test('returns "allow" when giteaConfig exists but forcePushAction is absent', () => {
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
    ).toBe("allow");
  });

  test('returns "backup-branch" when configured', () => {
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

  test('returns "allow" explicitly when configured', () => {
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
