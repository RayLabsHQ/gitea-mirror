import { describe, expect, test } from "bun:test";
import {
  getMirrorOverrideGating,
  hasMirrorOverrides,
  listOverriddenKeys,
  MIRROR_GATING_REASONS,
  mirrorOptionsToFlags,
  normalizeMirrorOverrides,
  parseMirrorOverrides,
  resolveMirrorOptions,
  STARRED_CLAMPED_KEYS,
  UI_MIRROR_OVERRIDE_KEYS,
} from "./mirror-overrides";
import type { Config } from "@/types/config";
import type { Repository } from "@/lib/db/schema";

/** Minimal config carrying just the flags the resolver reads. */
function makeConfig(
  gitea: Record<string, unknown> = {},
  github: Record<string, unknown> = {}
): Partial<Config> {
  return {
    userId: "user-1",
    giteaConfig: gitea as any,
    githubConfig: github as any,
  };
}

function makeRepo(overrides: Partial<Repository> = {}): any {
  return {
    isStarred: false,
    mirrorOverrides: null,
    organization: "acme",
    ...overrides,
  };
}

describe("resolveMirrorOptions precedence", () => {
  test("falls back to global config when no overrides exist", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: true, mirrorIssues: true, wiki: false }),
      repository: makeRepo(),
    });

    expect(resolved.lfs).toBe(true);
    expect(resolved.mirrorIssues).toBe(true);
    expect(resolved.wiki).toBe(false);
  });

  test("treats missing global flags as false rather than undefined", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({}),
      repository: makeRepo(),
    });

    for (const value of Object.values(resolved)) {
      expect(typeof value).toBe("boolean");
    }
    expect(resolved.lfs).toBe(false);
  });

  test("organization override beats global config", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: true, mirrorIssues: true }),
      repository: makeRepo(),
      orgOverrides: { lfs: false },
    });

    expect(resolved.lfs).toBe(false);
    // Untouched flags still inherit from global.
    expect(resolved.mirrorIssues).toBe(true);
  });

  test("repository override beats global config", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: true }),
      repository: makeRepo({ mirrorOverrides: { lfs: false } as any }),
    });

    expect(resolved.lfs).toBe(false);
  });

  test("repository override beats organization override", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: false }),
      repository: makeRepo({ mirrorOverrides: { lfs: true } as any }),
      orgOverrides: { lfs: false },
    });

    expect(resolved.lfs).toBe(true);
  });

  test("resolution is per flag, not all-or-nothing", () => {
    // global: everything on. org turns issues off. repo turns lfs off.
    // Each flag should land on its own most-specific tier.
    const resolved = resolveMirrorOptions({
      config: makeConfig({
        lfs: true,
        wiki: true,
        mirrorIssues: true,
        mirrorReleases: true,
      }),
      repository: makeRepo({ mirrorOverrides: { lfs: false } as any }),
      orgOverrides: { mirrorIssues: false },
    });

    expect(resolved.lfs).toBe(false); // repo tier
    expect(resolved.mirrorIssues).toBe(false); // org tier
    expect(resolved.wiki).toBe(true); // global tier
    expect(resolved.mirrorReleases).toBe(true); // global tier
  });

  test("an explicit true override re-enables a globally disabled flag", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: false }),
      repository: makeRepo({ mirrorOverrides: { lfs: true } as any }),
    });

    expect(resolved.lfs).toBe(true);
  });

  test("null in an override means inherit, not false", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: true }),
      repository: makeRepo({ mirrorOverrides: { lfs: null } as any }),
      orgOverrides: { lfs: null },
    });

    expect(resolved.lfs).toBe(true);
  });
});

describe("resolveMirrorOptions and starredCodeOnly", () => {
  test("starredCodeOnly forces metadata off for starred repos", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig(
        {
          lfs: true,
          wiki: true,
          mirrorIssues: true,
          mirrorPullRequests: true,
          mirrorReleases: true,
          mirrorLabels: true,
          mirrorMilestones: true,
          mirrorMetadata: true,
        },
        { starredCodeOnly: true }
      ),
      repository: makeRepo({ isStarred: true }),
    });

    expect(resolved.wiki).toBe(false);
    expect(resolved.mirrorIssues).toBe(false);
    expect(resolved.mirrorPullRequests).toBe(false);
    expect(resolved.mirrorReleases).toBe(false);
    expect(resolved.mirrorLabels).toBe(false);
    expect(resolved.mirrorMilestones).toBe(false);
    expect(resolved.mirrorMetadata).toBe(false);
    // LFS is code, not metadata, so it survives the clamp.
    expect(resolved.lfs).toBe(true);
  });

  test("starredCodeOnly clamp outranks an explicit repo override", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({}, { starredCodeOnly: true }),
      repository: makeRepo({
        isStarred: true,
        mirrorOverrides: { mirrorIssues: true } as any,
      }),
    });

    expect(resolved.mirrorIssues).toBe(false);
  });

  test("starredCodeOnly does not affect non-starred repos", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ mirrorIssues: true }, { starredCodeOnly: true }),
      repository: makeRepo({ isStarred: false }),
    });

    expect(resolved.mirrorIssues).toBe(true);
  });

  test("starred repo without starredCodeOnly keeps its metadata flags", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ mirrorIssues: true }, { starredCodeOnly: false }),
      repository: makeRepo({ isStarred: true }),
    });

    expect(resolved.mirrorIssues).toBe(true);
  });

  test("the #361 case: repo opts out of LFS, everything else unchanged", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: true, mirrorIssues: true, mirrorReleases: true }),
      repository: makeRepo({
        mirrorOverrides: { lfs: false } as any,
      }),
    });

    expect(resolved.lfs).toBe(false);
    expect(resolved.mirrorIssues).toBe(true);
    expect(resolved.mirrorReleases).toBe(true);
  });
});

describe("parseMirrorOverrides", () => {
  test("returns null for null, undefined and empty string", () => {
    expect(parseMirrorOverrides(null)).toBeNull();
    expect(parseMirrorOverrides(undefined)).toBeNull();
    expect(parseMirrorOverrides("")).toBeNull();
    expect(parseMirrorOverrides("   ")).toBeNull();
  });

  test("parses a JSON string payload", () => {
    expect(parseMirrorOverrides('{"lfs":false}')).toEqual({ lfs: false });
  });

  test("accepts an already-parsed object", () => {
    expect(parseMirrorOverrides({ lfs: true })).toEqual({ lfs: true });
  });

  test("degrades malformed input to null instead of throwing", () => {
    // A bad override must never be able to break a mirror run.
    expect(parseMirrorOverrides("{not json")).toBeNull();
    expect(parseMirrorOverrides([1, 2, 3])).toBeNull();
    expect(parseMirrorOverrides(42)).toBeNull();
    expect(parseMirrorOverrides({ lfs: "yes" })).toBeNull();
  });

  test("a malformed override falls back to global config in the resolver", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: true }),
      repository: makeRepo({ mirrorOverrides: "{corrupt" as any }),
    });

    expect(resolved.lfs).toBe(true);
  });
});

describe("override helpers", () => {
  test("hasMirrorOverrides only counts pinned flags", () => {
    expect(hasMirrorOverrides(null)).toBe(false);
    expect(hasMirrorOverrides({})).toBe(false);
    expect(hasMirrorOverrides({ lfs: null })).toBe(false);
    expect(hasMirrorOverrides({ lfs: false })).toBe(true);
    expect(hasMirrorOverrides({ lfs: true })).toBe(true);
  });

  test("listOverriddenKeys reports which flags deviate", () => {
    expect(listOverriddenKeys({ lfs: false, mirrorIssues: true })).toEqual([
      "lfs",
      "mirrorIssues",
    ]);
    expect(listOverriddenKeys({ lfs: null })).toEqual([]);
  });

  test("normalizeMirrorOverrides strips nulls and collapses empty to null", () => {
    expect(normalizeMirrorOverrides({ lfs: null, wiki: undefined })).toBeNull();
    expect(normalizeMirrorOverrides({})).toBeNull();
    expect(normalizeMirrorOverrides({ lfs: false, wiki: null })).toEqual({
      lfs: false,
    });
  });
});

describe("getMirrorOverrideGating - starred clamp", () => {
  const starredRepo = {
    targetKind: "repository" as const,
    isStarred: true,
    starredCodeOnly: true,
    effective: {},
  };

  test("disables every metadata flag with the starred reason", () => {
    const gating = getMirrorOverrideGating(starredRepo);

    for (const key of STARRED_CLAMPED_KEYS) {
      expect(gating[key]).toBe(MIRROR_GATING_REASONS.starredCodeOnly);
    }
  });

  test("LFS stays editable for starred repos", () => {
    // Regression guard for issue #361: LFS is repository content, not
    // metadata. The clamp must never sweep it up, or the whole feature breaks
    // for exactly the repos it was built for.
    const gating = getMirrorOverrideGating(starredRepo);

    expect(gating.lfs).toBeUndefined();
  });

  test("STARRED_CLAMPED_KEYS never contains lfs", () => {
    expect(STARRED_CLAMPED_KEYS).not.toContain("lfs");
  });

  test("no clamp when the repo is starred but starredCodeOnly is off", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      isStarred: true,
      starredCodeOnly: false,
      effective: {},
    });

    expect(Object.keys(gating)).toHaveLength(0);
  });

  test("no clamp when starredCodeOnly is on but the repo is not starred", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      isStarred: false,
      starredCodeOnly: true,
      effective: {},
    });

    expect(Object.keys(gating)).toHaveLength(0);
  });

  test("organizations never get the starred clamp", () => {
    // Orgs cannot be starred, so the org dialog must not show this at all.
    const gating = getMirrorOverrideGating({
      targetKind: "organization",
      isStarred: true,
      starredCodeOnly: true,
      effective: {},
    });

    expect(gating.mirrorIssues).toBeUndefined();
    expect(gating.wiki).toBeUndefined();
  });

  test("the clamp set matches what the resolver actually forces off", () => {
    // Guards against the UI disabling a different set of flags than the
    // runtime clamps, which would put the two out of sync silently.
    const resolved = resolveMirrorOptions({
      config: makeConfig(
        {
          lfs: true,
          wiki: true,
          mirrorReleases: true,
          mirrorMetadata: true,
          mirrorIssues: true,
          mirrorPullRequests: true,
          mirrorLabels: true,
          mirrorMilestones: true,
        },
        { starredCodeOnly: true }
      ),
      repository: makeRepo({ isStarred: true }),
    });

    for (const key of STARRED_CLAMPED_KEYS) {
      expect(resolved[key]).toBe(false);
    }
    expect(resolved.lfs).toBe(true);
  });
});

describe("getMirrorOverrideGating - labels follow issues", () => {
  test("labels are disabled while issues resolve to on", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      effective: { mirrorIssues: true },
    });

    expect(gating.mirrorLabels).toBe(MIRROR_GATING_REASONS.labelsFollowIssues);
  });

  test("labels are editable when issues resolve to off", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      effective: { mirrorIssues: false },
    });

    expect(gating.mirrorLabels).toBeUndefined();
  });

  test("applies to organizations too", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "organization",
      effective: { mirrorIssues: true },
    });

    expect(gating.mirrorLabels).toBe(MIRROR_GATING_REASONS.labelsFollowIssues);
  });

  test("the starred reason wins over the labels reason", () => {
    // Both rules apply; the more fundamental one should be the one explained.
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      isStarred: true,
      starredCodeOnly: true,
      effective: { mirrorIssues: true },
    });

    expect(gating.mirrorLabels).toBe(MIRROR_GATING_REASONS.starredCodeOnly);
  });

  test("gating matches the runtime rule for labels", () => {
    // Runtime is `mirrorLabels && !mirrorIssues` in gitea.ts and
    // gitea-enhanced.ts, so labels genuinely cannot take effect while issues
    // are on. Confirm the resolver agrees with what the UI claims.
    const resolved = resolveMirrorOptions({
      config: makeConfig({ mirrorIssues: true, mirrorLabels: true }),
      repository: makeRepo(),
    });

    expect(resolved.mirrorIssues).toBe(true);
    expect(resolved.mirrorLabels).toBe(true);
    // The runtime then suppresses the labels-only pass; the UI says so up front.
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      effective: resolved,
    });
    expect(gating.mirrorLabels).toBe(MIRROR_GATING_REASONS.labelsFollowIssues);
  });
});

describe("UI_MIRROR_OVERRIDE_KEYS", () => {
  test("exposes lfs plus the flags the runtime actually reads", () => {
    expect(UI_MIRROR_OVERRIDE_KEYS).toEqual([
      "lfs",
      "wiki",
      "mirrorIssues",
      "mirrorPullRequests",
      "mirrorReleases",
      "mirrorLabels",
      "mirrorMilestones",
    ]);
  });

  test("excludes mirrorMetadata, which no mirror path reads", () => {
    // mirrorMetadata is a write-time master switch in the global settings UI
    // (config-mapper ANDs it into the individual flags on save). Neither
    // gitea.ts nor gitea-enhanced.ts reads it, so a per-object override would
    // resolve fine and then do nothing.
    expect(UI_MIRROR_OVERRIDE_KEYS).not.toContain("mirrorMetadata");
  });
});

describe("mirrorOptionsToFlags - client/server shape contract", () => {
  // These tests deliberately go through config-mapper rather than hand-writing
  // an API payload. The original bug was that the dialog read
  // `giteaConfig.lfs`, which /api/config never returns: mapDbToUiConfig
  // reshapes the flags into `mirrorOptions` with different names and nesting.
  // A synthetic DB-shaped config cannot expose that mismatch, so the flags are
  // pushed through the real mapping in both directions here. If config-mapper
  // changes shape again, these fail.

  /** A DB-shaped config row, as the mirror runtime actually sees it. */
  function makeDbConfig(giteaOverrides: Record<string, unknown> = {}) {
    return {
      githubConfig: {
        owner: "acme",
        includeForks: true,
        starredCodeOnly: false,
      },
      giteaConfig: {
        url: "https://gitea.example.com",
        token: "t",
        defaultOwner: "acme",
        lfs: true,
        wiki: false,
        mirrorMetadata: true,
        mirrorIssues: true,
        mirrorPullRequests: false,
        mirrorLabels: true,
        mirrorMilestones: false,
        mirrorReleases: true,
        releaseLimit: 10,
        ...giteaOverrides,
      },
    };
  }

  test("flags survive the DB -> API -> flags round trip", async () => {
    const { mapDbToUiConfig } = await import("./config-mapper");
    const dbConfig = makeDbConfig();

    // This is exactly what /api/config sends to the browser.
    const apiShape = mapDbToUiConfig(dbConfig);
    const flags = mirrorOptionsToFlags(apiShape.mirrorOptions);

    expect(flags.lfs).toBe(true);
    expect(flags.mirrorIssues).toBe(true);
    expect(flags.mirrorReleases).toBe(true);
    expect(flags.mirrorLabels).toBe(true);
    expect(flags.mirrorPullRequests).toBe(false);
    expect(flags.mirrorMilestones).toBe(false);
    expect(flags.wiki).toBe(false);
  });

  test("the API payload really does not carry flags on giteaConfig", async () => {
    // Pins the root cause. If someone later makes /api/config also return the
    // flags on giteaConfig, this fails and the client mapping can be revisited.
    const { mapDbToUiConfig } = await import("./config-mapper");
    const apiShape = mapDbToUiConfig(makeDbConfig());

    expect((apiShape.giteaConfig as any).lfs).toBeUndefined();
    expect((apiShape.giteaConfig as any).mirrorIssues).toBeUndefined();
    // ...while mirrorOptions does, under different names.
    expect(apiShape.mirrorOptions.mirrorLFS).toBe(true);
    expect(apiShape.mirrorOptions.metadataComponents.issues).toBe(true);
  });

  test("reading giteaConfig directly yields the all-off bug", async () => {
    // Reproduces the reported symptom: every hint read "currently off" because
    // undefined coerces to false and is indistinguishable from a real off.
    const { mapDbToUiConfig } = await import("./config-mapper");
    const apiShape = mapDbToUiConfig(makeDbConfig());
    const buggy = {
      lfs: !!(apiShape.giteaConfig as any).lfs,
      mirrorIssues: !!(apiShape.giteaConfig as any).mirrorIssues,
    };

    expect(buggy.lfs).toBe(false); // DB says true
    expect(buggy.mirrorIssues).toBe(false); // DB says true

    const fixed = mirrorOptionsToFlags(apiShape.mirrorOptions);
    expect(fixed.lfs).toBe(true);
    expect(fixed.mirrorIssues).toBe(true);
  });

  test("the labels gate fires on a real API payload", async () => {
    // The gate itself was correct but was being fed undefined, so it never
    // fired. Drive it from a genuine payload instead.
    const { mapDbToUiConfig } = await import("./config-mapper");
    const apiShape = mapDbToUiConfig(makeDbConfig());
    const effective = mirrorOptionsToFlags(apiShape.mirrorOptions);

    expect(effective.mirrorIssues).toBe(true);
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      effective,
    });
    expect(gating.mirrorLabels).toBe(MIRROR_GATING_REASONS.labelsFollowIssues);
  });

  test("mirrorMetadata off forces the metadata components off", async () => {
    const { mapDbToUiConfig } = await import("./config-mapper");
    const apiShape = mapDbToUiConfig(
      makeDbConfig({ mirrorMetadata: false })
    );
    const flags = mirrorOptionsToFlags(apiShape.mirrorOptions);

    expect(flags.mirrorIssues).toBe(false);
    expect(flags.mirrorLabels).toBe(false);
    expect(flags.wiki).toBe(false);
    // lfs and releases sit outside the master switch.
    expect(flags.lfs).toBe(true);
    expect(flags.mirrorReleases).toBe(true);
  });

  test("matches what config-mapper would write back to the DB", async () => {
    // Strongest form of the contract: the flags this derives must equal the
    // flags mapUiToDbConfig would persist from the same mirrorOptions.
    const { mapDbToUiConfig, mapUiToDbConfig } = await import("./config-mapper");
    const apiShape = mapDbToUiConfig(makeDbConfig());

    const roundTripped = mapUiToDbConfig(
      apiShape.githubConfig,
      apiShape.giteaConfig,
      apiShape.mirrorOptions,
      apiShape.advancedOptions
    ).giteaConfig;

    const flags = mirrorOptionsToFlags(apiShape.mirrorOptions);

    for (const key of [
      "lfs",
      "wiki",
      "mirrorIssues",
      "mirrorPullRequests",
      "mirrorReleases",
      "mirrorLabels",
      "mirrorMilestones",
    ] as const) {
      expect(flags[key]).toBe(!!(roundTripped as any)[key]);
    }
  });

  test("handles a missing or empty payload without throwing", () => {
    for (const value of [null, undefined, {}]) {
      const flags = mirrorOptionsToFlags(value as any);
      expect(flags.lfs).toBe(false);
      expect(flags.mirrorIssues).toBe(false);
    }
  });
});
