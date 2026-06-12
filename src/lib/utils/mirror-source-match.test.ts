import { describe, test, expect } from "bun:test";
import {
  normalizeCloneUrl,
  cloneUrlsMatch,
  isMirrorOfSource,
  classifyCandidateName,
  findExistingMirror,
} from "./mirror-source-match";
import type { Repository } from "@/lib/db/schema";
import type { Config } from "@/types/config";

// Minimal Repository factory for tests. Only the fields read by the helper
// matter (cloneUrl, mirroredLocation, fullName, name).
function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-1",
    userId: "user-1",
    configId: "config-1",
    name: "Update",
    fullName: "NostalgiaForInfinity/Update",
    url: "https://github.com/NostalgiaForInfinity/Update",
    cloneUrl: "https://github.com/NostalgiaForInfinity/Update.git",
    owner: "NostalgiaForInfinity",
    organization: undefined,
    mirroredLocation: "",
    isPrivate: false,
    isForked: false,
    forkedFrom: undefined,
    hasIssues: false,
    isStarred: true,
    isArchived: false,
    size: 0,
    hasLFS: false,
    hasSubmodules: false,
    language: undefined,
    description: undefined,
    defaultBranch: "main",
    visibility: "public",
    status: "imported",
    lastMirrored: undefined,
    errorMessage: undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Repository;
}

const config: Partial<Config> = {
  userId: "user-1",
  giteaConfig: { url: "https://gitea.example.com", token: "t" } as any,
};

describe("normalizeCloneUrl", () => {
  test("strips trailing .git", () => {
    expect(normalizeCloneUrl("https://github.com/a/b.git")).toBe(
      "https://github.com/a/b"
    );
  });

  test("strips embedded credentials", () => {
    expect(normalizeCloneUrl("https://x-access-token:ghp_secret@github.com/a/b.git")).toBe(
      "https://github.com/a/b"
    );
  });

  test("strips trailing slash", () => {
    expect(normalizeCloneUrl("https://github.com/a/b/")).toBe(
      "https://github.com/a/b"
    );
  });

  test("lowercases host (and value)", () => {
    expect(normalizeCloneUrl("https://GitHub.com/a/b")).toBe(
      "https://github.com/a/b"
    );
  });

  test("returns empty string for blank/invalid input", () => {
    expect(normalizeCloneUrl("")).toBe("");
    expect(normalizeCloneUrl(null)).toBe("");
    expect(normalizeCloneUrl(undefined)).toBe("");
  });

  test("handles scp-style git URLs via fallback", () => {
    expect(normalizeCloneUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b");
  });
});

describe("cloneUrlsMatch", () => {
  test("https vs token-embedded URL match", () => {
    expect(
      cloneUrlsMatch(
        "https://github.com/a/b.git",
        "https://x-access-token:tok@github.com/a/b.git"
      )
    ).toBe(true);
  });

  test(".git suffix and trailing slash differences match", () => {
    expect(
      cloneUrlsMatch("https://github.com/a/b", "https://github.com/a/b.git/")
    ).toBe(true);
  });

  test("host case-insensitive match", () => {
    expect(
      cloneUrlsMatch("https://GITHUB.com/a/b", "https://github.com/a/b")
    ).toBe(true);
  });

  test("different repos do not match", () => {
    expect(
      cloneUrlsMatch("https://github.com/a/b", "https://github.com/c/d")
    ).toBe(false);
  });

  test("empty/unknown URL never matches", () => {
    expect(cloneUrlsMatch("", "https://github.com/a/b")).toBe(false);
    expect(cloneUrlsMatch("https://github.com/a/b", undefined)).toBe(false);
  });
});

describe("isMirrorOfSource", () => {
  test("true when mirror with matching original_url", () => {
    expect(
      isMirrorOfSource(
        { mirror: true, original_url: "https://github.com/a/b" } as any,
        "https://github.com/a/b.git"
      )
    ).toBe(true);
  });

  test("false when not a mirror", () => {
    expect(
      isMirrorOfSource(
        { mirror: false, original_url: "https://github.com/a/b" } as any,
        "https://github.com/a/b"
      )
    ).toBe(false);
  });

  test("false when original_url is for a different source (phantom fork)", () => {
    expect(
      isMirrorOfSource(
        { mirror: true, original_url: "https://github.com/other/repo" } as any,
        "https://github.com/a/b"
      )
    ).toBe(false);
  });

  test("false when original_url missing (cannot confirm)", () => {
    expect(
      isMirrorOfSource({ mirror: true } as any, "https://github.com/a/b")
    ).toBe(false);
  });

  test("false for null repoInfo", () => {
    expect(isMirrorOfSource(null, "https://github.com/a/b")).toBe(false);
  });
});

describe("findExistingMirror", () => {
  test("reuses existing same-source mirror at base candidate name (#315)", async () => {
    const repo = makeRepo();
    const getRepoInfo = async ({ owner, repoName }: any) => {
      if (owner === "starred" && repoName === "Update") {
        return {
          mirror: true,
          original_url: "https://github.com/NostalgiaForInfinity/Update",
        } as any;
      }
      return null;
    };

    const match = await findExistingMirror({
      repository: repo,
      config,
      candidateOwner: "starred",
      candidateName: "Update",
      getRepoInfo,
    });

    expect(match).not.toBeNull();
    expect(match!.owner).toBe("starred");
    expect(match!.repoName).toBe("Update");
  });

  test("reuses via mirroredLocation even when base name differs (strategy change, #309)", async () => {
    // Strategy changed; current candidate name would be "Update" under "starred",
    // but the historical mirror lives at "myorg/Update-NostalgiaForInfinity".
    const repo = makeRepo({
      mirroredLocation: "myorg/Update-NostalgiaForInfinity",
    });
    const getRepoInfo = async ({ owner, repoName }: any) => {
      if (owner === "myorg" && repoName === "Update-NostalgiaForInfinity") {
        return {
          mirror: true,
          original_url: "https://github.com/NostalgiaForInfinity/Update",
        } as any;
      }
      return null;
    };

    const match = await findExistingMirror({
      repository: repo,
      config,
      candidateOwner: "starred",
      candidateName: "Update",
      getRepoInfo,
    });

    expect(match).not.toBeNull();
    expect(match!.owner).toBe("myorg");
    expect(match!.repoName).toBe("Update-NostalgiaForInfinity");
  });

  test("returns null on genuine different-source collision (regression guard #95/#236)", async () => {
    const repo = makeRepo();
    const getRepoInfo = async ({ owner, repoName }: any) => {
      if (owner === "starred" && repoName === "Update") {
        // Same name, but it mirrors a DIFFERENT source.
        return {
          mirror: true,
          original_url: "https://github.com/someoneelse/Update",
        } as any;
      }
      return null;
    };

    const match = await findExistingMirror({
      repository: repo,
      config,
      candidateOwner: "starred",
      candidateName: "Update",
      getRepoInfo,
    });

    expect(match).toBeNull();
  });

  test("returns null for phantom fork (non-mirror at the name)", async () => {
    const repo = makeRepo();
    const getRepoInfo = async ({ owner, repoName }: any) => {
      if (owner === "starred" && repoName === "Update") {
        return { mirror: false, original_url: "" } as any;
      }
      return null;
    };

    const match = await findExistingMirror({
      repository: repo,
      config,
      candidateOwner: "starred",
      candidateName: "Update",
      getRepoInfo,
    });

    expect(match).toBeNull();
  });

  test("falls back to fresh creation when mirroredLocation is stale (Gitea repo deleted)", async () => {
    const repo = makeRepo({ mirroredLocation: "starred/Update" });
    // Both the recorded location and the base candidate are gone.
    const getRepoInfo = async () => null;

    const match = await findExistingMirror({
      repository: repo,
      config,
      candidateOwner: "starred",
      candidateName: "Update",
      getRepoInfo,
    });

    expect(match).toBeNull();
  });

  test("matches mirror even when original_url is token-embedded / .git-suffixed", async () => {
    const repo = makeRepo();
    const getRepoInfo = async ({ owner, repoName }: any) => {
      if (owner === "starred" && repoName === "Update") {
        return {
          mirror: true,
          original_url:
            "https://x-access-token:tok@github.com/NostalgiaForInfinity/Update.git",
        } as any;
      }
      return null;
    };

    const match = await findExistingMirror({
      repository: repo,
      config,
      candidateOwner: "starred",
      candidateName: "Update",
      getRepoInfo,
    });

    expect(match).not.toBeNull();
  });

  test("skips a candidate whose lookup throws and still resolves a later candidate", async () => {
    const repo = makeRepo({ mirroredLocation: "myorg/Update" });
    const getRepoInfo = async ({ owner }: any) => {
      if (owner === "myorg") {
        throw new Error("network blip");
      }
      if (owner === "starred") {
        return {
          mirror: true,
          original_url: "https://github.com/NostalgiaForInfinity/Update",
        } as any;
      }
      return null;
    };

    const match = await findExistingMirror({
      repository: repo,
      config,
      candidateOwner: "starred",
      candidateName: "Update",
      getRepoInfo,
    });

    expect(match).not.toBeNull();
    expect(match!.owner).toBe("starred");
  });
});

describe("classifyCandidateName — suffix vs reuse decision (#315/#309)", () => {
  const SOURCE = "https://github.com/NostalgiaForInfinity/Update.git";

  test("free name → available", () => {
    expect(
      classifyCandidateName({
        existsInGitea: false,
        claimedByOther: false,
        repoInfo: null,
        sourceCloneUrl: SOURCE,
      })
    ).toBe("available");
  });

  test("name occupied by OUR same-source mirror → reusable (no suffix, #315)", () => {
    expect(
      classifyCandidateName({
        existsInGitea: true,
        claimedByOther: false,
        repoInfo: {
          mirror: true,
          original_url: "https://github.com/NostalgiaForInfinity/Update",
        } as any,
        sourceCloneUrl: SOURCE,
      })
    ).toBe("reusable");
  });

  test("name occupied by a DIFFERENT source → taken (suffix, regression #95/#236)", () => {
    expect(
      classifyCandidateName({
        existsInGitea: true,
        claimedByOther: false,
        repoInfo: {
          mirror: true,
          original_url: "https://github.com/someoneelse/Update",
        } as any,
        sourceCloneUrl: SOURCE,
      })
    ).toBe("taken");
  });

  test("name occupied by a NON-mirror → taken (phantom-fork guard, #309)", () => {
    expect(
      classifyCandidateName({
        existsInGitea: true,
        claimedByOther: false,
        repoInfo: { mirror: false, original_url: "" } as any,
        sourceCloneUrl: SOURCE,
      })
    ).toBe("taken");
  });

  test("our same-source mirror but DB-claimed by ANOTHER repo → taken (per-user separation)", () => {
    expect(
      classifyCandidateName({
        existsInGitea: true,
        claimedByOther: true,
        repoInfo: {
          mirror: true,
          original_url: "https://github.com/NostalgiaForInfinity/Update",
        } as any,
        sourceCloneUrl: SOURCE,
      })
    ).toBe("taken");
  });

  test("free in Gitea but DB-claimed by another concurrent op → taken", () => {
    expect(
      classifyCandidateName({
        existsInGitea: false,
        claimedByOther: true,
        repoInfo: null,
        sourceCloneUrl: SOURCE,
      })
    ).toBe("taken");
  });

  test("existing mirror but unknown source (no sourceCloneUrl) → taken", () => {
    expect(
      classifyCandidateName({
        existsInGitea: true,
        claimedByOther: false,
        repoInfo: {
          mirror: true,
          original_url: "https://github.com/NostalgiaForInfinity/Update",
        } as any,
        sourceCloneUrl: undefined,
      })
    ).toBe("taken");
  });
});
