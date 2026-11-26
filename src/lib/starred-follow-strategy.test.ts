/**
 * Where starred repositories go (#551). "Preserve source owner" put each one
 * under its GitHub owner's name even with the single organization strategy,
 * and there was no way to place starred repositories like the rest. The
 * follow-strategy mode does that.
 *
 * gitea.test.ts replaces ./gitea with a stand-in, so this file loads the real
 * resolvers in its own process.
 */
import { describe, expect, test } from "bun:test";
import { runsIsolated } from "@/tests/isolated";
import type { Config } from "@/types/config";
import type { Repository } from "@/lib/db/schema";
import {
  normalizeStarredReposMode,
  usesStarredDestination,
} from "@/lib/utils/starred-destination";

const isolated = runsIsolated(import.meta.path);

const gitea = isolated
  ? await import("@/lib/gitea")
  : ({} as typeof import("@/lib/gitea"));

function config(starredReposMode: string | undefined, mirrorStrategy: string): Partial<Config> {
  return {
    userId: "user-1",
    githubConfig: {
      owner: "me",
      starredReposOrg: "stars",
      starredReposMode,
      mirrorStrategy,
    } as any,
    giteaConfig: {
      url: "https://gitea.example.com",
      token: "t",
      defaultOwner: "me-on-gitea",
      organization: "github-mirrors",
    } as any,
  };
}

/** Someone else's repository you starred: personal by default. */
function starred(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "r1",
    name: "tool",
    fullName: "alice/tool",
    owner: "alice",
    organization: null,
    isStarred: true,
    destinationOrg: null,
    ...overrides,
  } as unknown as Repository;
}

describe("starred-destination helpers", () => {
  test("an unknown or missing mode reads as dedicated-org", () => {
    expect(normalizeStarredReposMode(undefined)).toBe("dedicated-org");
    expect(normalizeStarredReposMode("sideways")).toBe("dedicated-org");
    expect(normalizeStarredReposMode("follow-strategy")).toBe("follow-strategy");
  });

  test("only starred repositories outside follow-strategy get the starred placement", () => {
    expect(usesStarredDestination({ isStarred: true }, "dedicated-org")).toBe(true);
    expect(usesStarredDestination({ isStarred: true }, "preserve-owner")).toBe(true);
    expect(usesStarredDestination({ isStarred: true }, undefined)).toBe(true);
    expect(usesStarredDestination({ isStarred: true }, "follow-strategy")).toBe(false);
    expect(usesStarredDestination({ isStarred: false }, "dedicated-org")).toBe(false);
  });
});

describe.skipIf(!isolated)("starred placement (#551)", () => {
  test("follow-strategy puts starred repositories where the strategy puts the rest", () => {
    const owner = (strategy: string, repo: Repository) =>
      gitea.getGiteaRepoOwner({ config: config("follow-strategy", strategy), repository: repo });
    const orgRepo = starred({ fullName: "acme/lib", owner: "acme", organization: "acme" });

    // The issue's setup: single organization.
    expect(owner("single-org", starred())).toBe("github-mirrors");
    expect(owner("single-org", orgRepo)).toBe("github-mirrors");
    expect(owner("flat-user", starred())).toBe("me-on-gitea");
    expect(owner("mixed", starred())).toBe("github-mirrors");
    expect(owner("mixed", orgRepo)).toBe("acme");
    expect(owner("preserve", starred())).toBe("alice");
    expect(owner("preserve", orgRepo)).toBe("acme");
  });

  test("follow-strategy honors a repository's and an organization's own destination", () => {
    const cfg = config("follow-strategy", "single-org");
    expect(
      gitea.resolveDestinationOwner({ config: cfg, repository: starred({ destinationOrg: "picked" }) })
    ).toBe("picked");
    expect(
      gitea.resolveDestinationOwner({
        config: cfg,
        repository: starred({ organization: "acme", owner: "acme" }),
        organizationDestination: "acme-mirror",
      })
    ).toBe("acme-mirror");
  });

  test("the other two modes are unchanged and still win over per-repository destinations", () => {
    const repo = starred({ destinationOrg: "picked" });
    expect(
      gitea.resolveDestinationOwner({ config: config("dedicated-org", "single-org"), repository: repo })
    ).toBe("stars");
    expect(
      gitea.resolveDestinationOwner({ config: config("preserve-owner", "single-org"), repository: repo })
    ).toBe("alice");
    expect(
      gitea.resolveDestinationOwner({ config: config(undefined, "single-org"), repository: repo })
    ).toBe("stars");
  });

  test("non-starred repositories are not affected by the starred mode", () => {
    const own = starred({ isStarred: false, owner: "me", fullName: "me/tool" });
    for (const mode of ["dedicated-org", "preserve-owner", "follow-strategy"]) {
      expect(gitea.getGiteaRepoOwner({ config: config(mode, "single-org"), repository: own })).toBe(
        "github-mirrors"
      );
    }
  });
});
