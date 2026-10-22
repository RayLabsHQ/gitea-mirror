import { describe, expect, test } from "bun:test";
import {
  compileReleaseTagPattern,
  compileReleaseTagPatterns,
  DEFAULT_RELEASE_LIMIT,
  DEFAULT_RELEASE_TYPE,
  getMirrorOverrideGating,
  hasMirrorOverrides,
  listOverriddenKeys,
  MAX_RELEASE_TAG_PATTERNS,
  MAX_RELEASE_TAG_PATTERN_LENGTH,
  MIRROR_GATING_REASONS,
  MIRROR_OVERRIDE_CHOICE_KEYS,
  MIRROR_OVERRIDE_KEYS,
  MIRROR_OVERRIDE_LABELS,
  MIRROR_OVERRIDE_LIMIT_KEYS,
  MIRROR_OVERRIDE_PATTERN_KEYS,
  mirrorOptionsToFlags,
  normalizeMirrorOverrides,
  normalizeReleaseAssetLimit,
  normalizeReleaseLimit,
  normalizeReleaseTagPatterns,
  normalizeReleaseType,
  orgForkSkipDecision,
  parseMirrorOverrides,
  releaseGetsAssets,
  releaseMatchesTagFilters,
  releaseMatchesType,
  releaseScanLimit,
  releaseTagMatchesAny,
  RELEASE_SCAN_WINDOW,
  resolveMirrorOptions,
  resolveOrganizationSkipForks,
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

    for (const key of MIRROR_OVERRIDE_KEYS) {
      expect(typeof resolved[key]).toBe("boolean");
    }
    expect(resolved.lfs).toBe(false);
    expect(resolved.releaseLimit).toBe(DEFAULT_RELEASE_LIMIT);
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

  test("derived flags equal the stored DB flags the runtime reads", async () => {
    // The property that actually matters: what the dialog shows must equal
    // what the mirror paths will do. Both read the same stored fields, so
    // pushing DB state out through the API mapping and back must be lossless.
    //
    // This replaces an earlier assertion that compared against
    // mapUiToDbConfig's *write* derivation. That was the wrong reference: it
    // pinned the write-path mirrorMetadata AND into the read path and so
    // enshrined the bug it was meant to guard.
    const { mapDbToUiConfig } = await import("./config-mapper");
    const dbConfig = makeDbConfig();
    const flags = mirrorOptionsToFlags(
      mapDbToUiConfig(dbConfig).mirrorOptions
    );

    const stored = dbConfig.giteaConfig as unknown as Record<string, boolean>;
    expect(flags.lfs).toBe(stored.lfs);
    expect(flags.wiki).toBe(stored.wiki);
    expect(flags.mirrorIssues).toBe(stored.mirrorIssues);
    expect(flags.mirrorPullRequests).toBe(stored.mirrorPullRequests);
    expect(flags.mirrorReleases).toBe(stored.mirrorReleases);
    expect(flags.mirrorLabels).toBe(stored.mirrorLabels);
    expect(flags.mirrorMilestones).toBe(stored.mirrorMilestones);
  });

  test("mirrorMetadata does not gate the components on read", async () => {
    // Reachable via env vars: MIRROR_METADATA=false with MIRROR_ISSUES=true
    // stores an inconsistent pair. The runtime reads mirrorIssues directly and
    // mirrors issues, so the dialog must say so too. ANDing with
    // mirrorMetadata here would double-apply a write-path rule and report off.
    const { mapDbToUiConfig } = await import("./config-mapper");
    const dbConfig = makeDbConfig({
      mirrorMetadata: false,
      mirrorIssues: true,
      mirrorLabels: true,
      wiki: true,
    });
    const flags = mirrorOptionsToFlags(
      mapDbToUiConfig(dbConfig).mirrorOptions
    );

    expect(flags.mirrorIssues).toBe(true);
    expect(flags.mirrorLabels).toBe(true);
    expect(flags.wiki).toBe(true);
  });

  test("the dialog agrees with the resolver on an inconsistent config", async () => {
    // Same state, checked against the resolver the mirror paths actually use,
    // rather than against the raw DB object.
    const { mapDbToUiConfig } = await import("./config-mapper");
    const dbConfig = makeDbConfig({ mirrorMetadata: false, mirrorIssues: true });

    const runtime = resolveMirrorOptions({
      config: makeConfig(dbConfig.giteaConfig as any, {}),
      repository: makeRepo(),
    });
    const client = mirrorOptionsToFlags(
      mapDbToUiConfig(dbConfig).mirrorOptions
    );

    for (const key of UI_MIRROR_OVERRIDE_KEYS) {
      expect(client[key]).toBe(runtime[key]);
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

describe("releaseLimit override", () => {
  test("falls back to the global release limit, then the default", () => {
    expect(
      resolveMirrorOptions({
        config: makeConfig({ releaseLimit: 25 }),
        repository: makeRepo(),
      }).releaseLimit
    ).toBe(25);
    expect(
      resolveMirrorOptions({ config: makeConfig({}), repository: makeRepo() })
        .releaseLimit
    ).toBe(DEFAULT_RELEASE_LIMIT);
  });

  test("organization override beats global, repository override beats organization", () => {
    const config = makeConfig({ releaseLimit: 25 });

    expect(
      resolveMirrorOptions({
        config,
        repository: makeRepo(),
        orgOverrides: { releaseLimit: 5 },
      }).releaseLimit
    ).toBe(5);
    expect(
      resolveMirrorOptions({
        config,
        repository: makeRepo({ mirrorOverrides: { releaseLimit: 2 } }),
        orgOverrides: { releaseLimit: 5 },
      }).releaseLimit
    ).toBe(2);
  });

  test("an unusable limit at one tier falls through instead of clamping to 1", () => {
    const config = makeConfig({ releaseLimit: 25 });

    expect(
      resolveMirrorOptions({
        config,
        repository: makeRepo({ mirrorOverrides: { releaseLimit: 0 } }),
        orgOverrides: { releaseLimit: 5 },
      }).releaseLimit
    ).toBe(5);
    expect(
      resolveMirrorOptions({
        config,
        repository: makeRepo({ mirrorOverrides: { releaseLimit: -3 } }),
      }).releaseLimit
    ).toBe(25);
    expect(
      resolveMirrorOptions({
        config: makeConfig({ releaseLimit: 0 }),
        repository: makeRepo(),
      }).releaseLimit
    ).toBe(DEFAULT_RELEASE_LIMIT);
  });

  test("fractional limits are floored", () => {
    expect(
      resolveMirrorOptions({
        config: makeConfig({}),
        repository: makeRepo({ mirrorOverrides: { releaseLimit: 3.9 } }),
      }).releaseLimit
    ).toBe(3);
  });

  test("null means inherit and does not disturb the boolean flags", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig({ releaseLimit: 7, lfs: true }),
      repository: makeRepo({
        mirrorOverrides: { releaseLimit: null, lfs: false },
      }),
    });

    expect(resolved.releaseLimit).toBe(7);
    expect(resolved.lfs).toBe(false);
  });

  test("a bad limit does not take the other overrides down with it", () => {
    // The schema accepts any number precisely so that a stored out-of-range
    // limit degrades to inherit for that field alone. The #361 LFS opt-out
    // stored next to it must survive.
    const resolved = resolveMirrorOptions({
      config: makeConfig({ lfs: true, releaseLimit: 25 }),
      repository: makeRepo({
        mirrorOverrides: { lfs: false, releaseLimit: -1 },
      }),
    });

    expect(resolved.lfs).toBe(false);
    expect(resolved.releaseLimit).toBe(25);
  });

  test("the starred clamp leaves the limit alone; releases are already forced off", () => {
    const resolved = resolveMirrorOptions({
      config: makeConfig(
        { mirrorReleases: true, releaseLimit: 7 },
        { starredCodeOnly: true }
      ),
      repository: makeRepo({
        isStarred: true,
        mirrorOverrides: { releaseLimit: 3 },
      }),
    });

    expect(resolved.mirrorReleases).toBe(false);
    expect(resolved.releaseLimit).toBe(3);
  });

  test("helpers treat a usable limit as a pinned override", () => {
    expect(hasMirrorOverrides({ releaseLimit: 5 })).toBe(true);
    expect(hasMirrorOverrides({ releaseLimit: 0 })).toBe(false);
    expect(hasMirrorOverrides({ releaseLimit: null })).toBe(false);
    expect(listOverriddenKeys({ lfs: false, releaseLimit: 5 })).toEqual([
      "lfs",
      "releaseLimit",
    ]);
    expect(normalizeMirrorOverrides({ releaseLimit: 5.7 })).toEqual({
      releaseLimit: 5,
    });
    expect(normalizeMirrorOverrides({ releaseLimit: 0 })).toBeNull();
    expect(normalizeMirrorOverrides({ lfs: false, releaseLimit: 0 })).toEqual({
      lfs: false,
    });
  });

  test("normalizeReleaseLimit accepts positive finite numbers only", () => {
    expect(normalizeReleaseLimit(10)).toBe(10);
    expect(normalizeReleaseLimit(2.5)).toBe(2);
    expect(normalizeReleaseLimit(0)).toBeUndefined();
    expect(normalizeReleaseLimit(0.4)).toBeUndefined();
    expect(normalizeReleaseLimit(-1)).toBeUndefined();
    expect(normalizeReleaseLimit(NaN)).toBeUndefined();
    expect(normalizeReleaseLimit(Infinity)).toBeUndefined();
    expect(normalizeReleaseLimit("5")).toBeUndefined();
    expect(normalizeReleaseLimit(null)).toBeUndefined();
    expect(normalizeReleaseLimit(undefined)).toBeUndefined();
  });

  test("mirrorOptionsToFlags carries the global limit for the Inherit hint", () => {
    expect(
      mirrorOptionsToFlags({ mirrorReleases: true, releaseLimit: 42 }).releaseLimit
    ).toBe(42);
    expect(mirrorOptionsToFlags(null).releaseLimit).toBe(DEFAULT_RELEASE_LIMIT);
  });

  test("the global limit survives the DB -> API -> flags round trip", async () => {
    const { mapDbToUiConfig } = await import("./config-mapper");
    const apiShape = mapDbToUiConfig({
      githubConfig: { owner: "acme" },
      giteaConfig: {
        url: "https://gitea.example.com",
        token: "t",
        defaultOwner: "acme",
        mirrorReleases: true,
        releaseLimit: 33,
      },
    } as any);

    expect(mirrorOptionsToFlags(apiShape.mirrorOptions).releaseLimit).toBe(33);
  });
});

describe("getMirrorOverrideGating - release limit follows releases", () => {
  test("limit is disabled while releases resolve to off", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      effective: { mirrorReleases: false },
    });
    expect(gating.releaseLimit).toBe(MIRROR_GATING_REASONS.releasesOff);
  });

  test("limit is editable while releases resolve to on", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      effective: { mirrorReleases: true },
    });
    expect(gating.releaseLimit).toBeUndefined();
  });

  test("the starred reason wins when that is what disabled releases", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "repository",
      isStarred: true,
      starredCodeOnly: true,
      effective: { mirrorReleases: true },
    });
    expect(gating.releaseLimit).toBe(MIRROR_GATING_REASONS.starredCodeOnly);
  });

  test("applies to organizations too", () => {
    const gating = getMirrorOverrideGating({
      targetKind: "organization",
      effective: { mirrorReleases: false },
    });
    expect(gating.releaseLimit).toBe(MIRROR_GATING_REASONS.releasesOff);
  });
});

import {
  GITHUB_ONLY_METADATA_KEYS,
  resolveMirrorOptions as resolveOptionsForSource,
} from "./mirror-overrides";
import { sourceKindSupportsReleases } from "@/lib/source-providers/kinds";

describe("resolveMirrorOptions for non-GitHub sources", () => {
  const config = {
    giteaConfig: {
      lfs: true,
      wiki: true,
      mirrorReleases: true,
      mirrorMetadata: true,
      mirrorIssues: true,
      mirrorPullRequests: true,
      mirrorLabels: true,
      mirrorMilestones: true,
      releaseLimit: 5,
    },
  } as any;

  test("a GitLab repository keeps code, wiki and LFS but no GitHub API metadata", () => {
    const resolved = resolveOptionsForSource({
      config,
      repository: { isStarred: false, mirrorOverrides: null, sourceProvider: "gitlab" } as any,
    });
    expect(resolved.lfs).toBe(true);
    expect(resolved.wiki).toBe(true);
    for (const key of GITHUB_ONLY_METADATA_KEYS) {
      expect(resolved[key]).toBe(false);
    }
  });

  test("the clamp outranks a per repository override", () => {
    const resolved = resolveOptionsForSource({
      config,
      repository: {
        isStarred: false,
        mirrorOverrides: { mirrorIssues: true },
        sourceProvider: "gitea",
      } as any,
    });
    expect(resolved.mirrorIssues).toBe(false);
  });

  test("rows without a source provider are GitHub rows and stay untouched", () => {
    const resolved = resolveOptionsForSource({
      config,
      repository: { isStarred: false, mirrorOverrides: null } as any,
    });
    expect(resolved.mirrorIssues).toBe(true);
    expect(resolved.mirrorReleases).toBe(true);
  });

  // #440: Gitea and Forgejo expose releases through their own API, so the
  // release switch is no longer part of the GitHub only clamp.
  test("a Gitea repository keeps releases while the GitHub only metadata is clamped", () => {
    const resolved = resolveOptionsForSource({
      config,
      repository: { isStarred: false, mirrorOverrides: null, sourceProvider: "gitea" } as any,
    });
    expect(resolved.mirrorReleases).toBe(true);
    expect(resolved.releaseLimit).toBe(5);
    expect(resolved.mirrorIssues).toBe(false);
    expect(resolved.mirrorPullRequests).toBe(false);
    expect(resolved.mirrorLabels).toBe(false);
    expect(resolved.mirrorMilestones).toBe(false);
    expect(resolved.mirrorMetadata).toBe(false);
  });

  test("forgejo and codeberg spellings resolve to the Gitea kind and keep releases", () => {
    for (const sourceProvider of ["forgejo", "codeberg"]) {
      const resolved = resolveOptionsForSource({
        config,
        repository: { isStarred: false, mirrorOverrides: null, sourceProvider } as any,
      });
      expect(resolved.mirrorReleases).toBe(true);
      expect(resolved.mirrorIssues).toBe(false);
    }
  });

  test("a GitLab repository still has releases and every other metadata flag clamped", () => {
    const resolved = resolveOptionsForSource({
      config,
      repository: {
        isStarred: false,
        mirrorOverrides: { mirrorReleases: true },
        sourceProvider: "gitlab",
      } as any,
    });
    expect(resolved.mirrorReleases).toBe(false);
    for (const key of GITHUB_ONLY_METADATA_KEYS) {
      expect(resolved[key]).toBe(false);
    }
  });

  test("releases left the GitHub only set, so the constant no longer lists them", () => {
    expect(GITHUB_ONLY_METADATA_KEYS as readonly string[]).not.toContain("mirrorReleases");
  });

  test("a Gitea repository still loses releases on a push destination", () => {
    const resolved = resolveOptionsForSource({
      config: {
        ...config,
        giteaConfig: { ...config.giteaConfig, provider: "github" },
      } as any,
      repository: { isStarred: false, mirrorOverrides: null, sourceProvider: "gitea" } as any,
    });
    expect(resolved.mirrorReleases).toBe(false);
  });

  test("starredCodeOnly still outranks the Gitea release capability", () => {
    const resolved = resolveOptionsForSource({
      config: { ...config, githubConfig: { starredCodeOnly: true } } as any,
      repository: { isStarred: true, mirrorOverrides: null, sourceProvider: "gitea" } as any,
    });
    expect(resolved.mirrorReleases).toBe(false);
  });
});

describe("sourceKindSupportsReleases", () => {
  test("GitHub and Gitea can list releases, GitLab cannot", () => {
    expect(sourceKindSupportsReleases("github")).toBe(true);
    expect(sourceKindSupportsReleases("gitea")).toBe(true);
    expect(sourceKindSupportsReleases("forgejo")).toBe(true);
    expect(sourceKindSupportsReleases("codeberg")).toBe(true);
    expect(sourceKindSupportsReleases("gitlab")).toBe(false);
  });

  test("an unknown value is a GitHub row, as everywhere else", () => {
    expect(sourceKindSupportsReleases(undefined)).toBe(true);
    expect(sourceKindSupportsReleases(null)).toBe(true);
    expect(sourceKindSupportsReleases("bitbucket")).toBe(true);
  });
});

describe("release asset limit (#311)", () => {
  describe("normalizeReleaseAssetLimit", () => {
    test("accepts 0 and positive integers, floors fractions", () => {
      expect(normalizeReleaseAssetLimit(0)).toBe(0);
      expect(normalizeReleaseAssetLimit(5)).toBe(5);
      expect(normalizeReleaseAssetLimit(2.9)).toBe(2);
    });

    test("rejects negatives, NaN, strings and absence", () => {
      expect(normalizeReleaseAssetLimit(-1)).toBeUndefined();
      expect(normalizeReleaseAssetLimit(Number.NaN)).toBeUndefined();
      expect(normalizeReleaseAssetLimit("3")).toBeUndefined();
      expect(normalizeReleaseAssetLimit(null)).toBeUndefined();
      expect(normalizeReleaseAssetLimit(undefined)).toBeUndefined();
    });

    test("differs from the release limit exactly at 0", () => {
      expect(normalizeReleaseLimit(0)).toBeUndefined();
      expect(normalizeReleaseAssetLimit(0)).toBe(0);
    });
  });

  describe("resolveMirrorOptions", () => {
    test("resolves to null (assets for every release) when no tier pins one", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseLimit: 10 }),
        repository: makeRepo(),
      });
      expect(resolved.releaseAssetLimit).toBeNull();
      expect(resolved.releaseLimit).toBe(10);
    });

    test("global asset limit applies when nothing overrides it", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseAssetLimit: 5 }),
        repository: makeRepo(),
      });
      expect(resolved.releaseAssetLimit).toBe(5);
    });

    test("a global 0 is a real value, not a fall-through", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseAssetLimit: 0 }),
        repository: makeRepo(),
      });
      expect(resolved.releaseAssetLimit).toBe(0);
    });

    test("organization override beats global, repository beats organization", () => {
      const config = makeConfig({ mirrorReleases: true, releaseAssetLimit: 5 });

      expect(
        resolveMirrorOptions({
          config,
          repository: makeRepo(),
          orgOverrides: { releaseAssetLimit: 2 },
        }).releaseAssetLimit
      ).toBe(2);

      expect(
        resolveMirrorOptions({
          config,
          repository: makeRepo({ mirrorOverrides: { releaseAssetLimit: 0 } }),
          orgOverrides: { releaseAssetLimit: 2 },
        }).releaseAssetLimit
      ).toBe(0);
    });

    test("null in an override means inherit", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseAssetLimit: 5 }),
        repository: makeRepo({ mirrorOverrides: { releaseAssetLimit: null } }),
        orgOverrides: { releaseAssetLimit: null },
      });
      expect(resolved.releaseAssetLimit).toBe(5);
    });

    test("an unusable override falls through to the next tier", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseAssetLimit: 5 }),
        repository: makeRepo({ mirrorOverrides: { releaseAssetLimit: -3 } }),
        orgOverrides: { releaseAssetLimit: 2 },
      });
      expect(resolved.releaseAssetLimit).toBe(2);
    });

    test("the asset limit is independent of the release limit", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseLimit: 3 }),
        repository: makeRepo({ mirrorOverrides: { releaseAssetLimit: 1 } }),
      });
      expect(resolved.releaseLimit).toBe(3);
      expect(resolved.releaseAssetLimit).toBe(1);
    });
  });

  describe("releaseGetsAssets", () => {
    test("null means every release gets assets", () => {
      expect(releaseGetsAssets(0, null)).toBe(true);
      expect(releaseGetsAssets(999, null)).toBe(true);
    });

    test("0 means no release gets assets", () => {
      expect(releaseGetsAssets(0, 0)).toBe(false);
    });

    test("N covers exactly the newest N releases, by index", () => {
      // Newest-first ordering: index 0 is the newest release.
      expect(releaseGetsAssets(0, 2)).toBe(true);
      expect(releaseGetsAssets(1, 2)).toBe(true);
      expect(releaseGetsAssets(2, 2)).toBe(false);
      expect(releaseGetsAssets(3, 2)).toBe(false);
    });

    test("a list of releases splits at the limit", () => {
      const tags = ["v5", "v4", "v3", "v2", "v1"];
      const withAssets = tags.filter((_, index) => releaseGetsAssets(index, 2));
      expect(withAssets).toEqual(["v5", "v4"]);
    });
  });

  describe("override helpers", () => {
    test("a pinned 0 counts as an override", () => {
      expect(hasMirrorOverrides({ releaseAssetLimit: 0 })).toBe(true);
      expect(listOverriddenKeys({ releaseAssetLimit: 0 })).toEqual([
        "releaseAssetLimit",
      ]);
    });

    test("null and unusable values do not count", () => {
      expect(hasMirrorOverrides({ releaseAssetLimit: null })).toBe(false);
      expect(hasMirrorOverrides({ releaseAssetLimit: -1 })).toBe(false);
      expect(listOverriddenKeys({ releaseAssetLimit: null })).toEqual([]);
    });

    test("normalizeMirrorOverrides keeps 0 and drops null", () => {
      expect(
        normalizeMirrorOverrides({ releaseAssetLimit: 0, releaseLimit: null })
      ).toEqual({ releaseAssetLimit: 0 });
      expect(normalizeMirrorOverrides({ releaseAssetLimit: null })).toBeNull();
    });

    test("the limit keys and labels agree", () => {
      expect(MIRROR_OVERRIDE_LIMIT_KEYS).toEqual(["releaseLimit", "releaseAssetLimit"]);
      for (const key of MIRROR_OVERRIDE_LIMIT_KEYS) {
        expect(MIRROR_OVERRIDE_LABELS[key]).toBeTruthy();
      }
    });
  });

  describe("mirrorOptionsToFlags", () => {
    test("reports null when the API sends no asset limit", () => {
      expect(
        mirrorOptionsToFlags({ mirrorReleases: true, releaseLimit: 10 }).releaseAssetLimit
      ).toBeNull();
      expect(
        mirrorOptionsToFlags({ mirrorReleases: true, releaseAssetLimit: null }).releaseAssetLimit
      ).toBeNull();
    });

    test("passes 0 and N through", () => {
      expect(mirrorOptionsToFlags({ releaseAssetLimit: 0 }).releaseAssetLimit).toBe(0);
      expect(mirrorOptionsToFlags({ releaseAssetLimit: 4 }).releaseAssetLimit).toBe(4);
    });
  });

  describe("getMirrorOverrideGating", () => {
    test("the asset limit is disabled with the release limit when releases are off", () => {
      const gating = getMirrorOverrideGating({
        targetKind: "repository",
        effective: { mirrorReleases: false },
      });
      expect(gating.releaseLimit).toBe(MIRROR_GATING_REASONS.releasesOff);
      expect(gating.releaseAssetLimit).toBe(MIRROR_GATING_REASONS.releasesOff);
    });

    test("the asset limit inherits the starred reason", () => {
      const gating = getMirrorOverrideGating({
        targetKind: "repository",
        isStarred: true,
        starredCodeOnly: true,
        effective: { mirrorReleases: true },
      });
      expect(gating.releaseAssetLimit).toBe(MIRROR_GATING_REASONS.starredCodeOnly);
    });

    test("the asset limit is editable while releases are on", () => {
      const gating = getMirrorOverrideGating({
        targetKind: "organization",
        effective: { mirrorReleases: true },
      });
      expect(gating.releaseAssetLimit).toBeUndefined();
    });
  });
});

describe("organization skip forks policy", () => {
  test("resolveOrganizationSkipForks defaults to the global switch", () => {
    expect(
      resolveOrganizationSkipForks({ orgOverrides: null, config: makeConfig({}, {}) })
    ).toBe(false);
    expect(
      resolveOrganizationSkipForks({
        orgOverrides: null,
        config: makeConfig({}, { skipForks: true }),
      })
    ).toBe(true);
  });

  test("an organization pin beats the global switch in either direction", () => {
    expect(
      resolveOrganizationSkipForks({
        orgOverrides: { skipForks: true },
        config: makeConfig({}, { skipForks: false }),
      })
    ).toBe(true);
    expect(
      resolveOrganizationSkipForks({
        orgOverrides: { skipForks: false },
        config: makeConfig({}, { skipForks: true }),
      })
    ).toBe(false);
  });

  test("a null pin means inherit, not false", () => {
    expect(
      resolveOrganizationSkipForks({
        orgOverrides: { skipForks: null },
        config: makeConfig({}, { skipForks: true }),
      })
    ).toBe(true);
  });

  test("orgForkSkipDecision resolves per organization, case-insensitively", () => {
    const decide = orgForkSkipDecision(
      new Map([["acme", true], ["globex", false]]),
      makeConfig({}, { skipForks: false })
    );
    expect(decide("Acme")).toBe(true);
    expect(decide("GLOBEX")).toBe(false);
    expect(decide("umbrella")).toBe(false);
    expect(decide(undefined)).toBe(false);
  });

  test("orgForkSkipDecision falls back to a global skip when no org is pinned", () => {
    const decide = orgForkSkipDecision(undefined, makeConfig({}, { skipForks: true }));
    expect(decide("acme")).toBe(true);
    expect(decide(undefined)).toBe(true);
    expect(decide("")).toBe(true);
  });

  test("skip forks participates in the storage helpers like any other pin", () => {
    expect(hasMirrorOverrides({ skipForks: true })).toBe(true);
    expect(listOverriddenKeys({ skipForks: true })).toEqual(["skipForks"]);
    expect(normalizeMirrorOverrides({ skipForks: true, lfs: null })).toEqual({
      skipForks: true,
    });
    expect(MIRROR_OVERRIDE_LABELS.skipForks).toBe("Skip forks");
  });

  test("skip forks is not part of the gitea mirror flag set the resolver walks", () => {
    expect(MIRROR_OVERRIDE_KEYS).not.toContain("skipForks");
    const resolved = resolveMirrorOptions({
      config: makeConfig({}),
      repository: makeRepo({ mirrorOverrides: { skipForks: true } as any }),
    });
    expect((resolved as any).skipForks).toBeUndefined();
  });
});

describe("release type filter", () => {
  describe("normalizeReleaseType", () => {
    test("accepts the two known values", () => {
      expect(normalizeReleaseType("all")).toBe("all");
      expect(normalizeReleaseType("stable")).toBe("stable");
    });

    test("folds case and padding so a hand-written env var works", () => {
      expect(normalizeReleaseType("Stable")).toBe("stable");
      expect(normalizeReleaseType("  STABLE  ")).toBe("stable");
    });

    test("rejects unknown words and non-strings", () => {
      expect(normalizeReleaseType("main")).toBeUndefined();
      expect(normalizeReleaseType("beta")).toBeUndefined();
      // The kind filter never offered pre-releases on their own, but a value
      // saved while it did must fall through to the next tier rather than pin
      // something the mirror no longer does.
      expect(normalizeReleaseType("prerelease")).toBeUndefined();
      expect(normalizeReleaseType("")).toBeUndefined();
      expect(normalizeReleaseType(true)).toBeUndefined();
      expect(normalizeReleaseType(1)).toBeUndefined();
      expect(normalizeReleaseType(null)).toBeUndefined();
      expect(normalizeReleaseType(undefined)).toBeUndefined();
    });
  });

  describe("releaseMatchesType", () => {
    test("all accepts every release", () => {
      expect(releaseMatchesType({ prerelease: true }, "all")).toBe(true);
      expect(releaseMatchesType({ prerelease: false }, "all")).toBe(true);
      expect(releaseMatchesType({}, "all")).toBe(true);
    });

    test("stable keeps everything the source does not flag", () => {
      expect(releaseMatchesType({ prerelease: false }, "stable")).toBe(true);
      expect(releaseMatchesType({ prerelease: true }, "stable")).toBe(false);
    });

    test("a release with no flag counts as a normal release", () => {
      // Dropping everything because a source omits the flag would silently
      // empty a mirror, so unknown is treated as "not a pre-release".
      expect(releaseMatchesType({}, "stable")).toBe(true);
      expect(releaseMatchesType({ prerelease: null }, "stable")).toBe(true);
    });

    test("a filter splits a newest-first list", () => {
      const releases = [
        { prerelease: true },
        { prerelease: false },
        { prerelease: true },
        {},
      ];
      expect(releases.filter((r) => releaseMatchesType(r, "stable"))).toHaveLength(2);
      expect(releases.filter((r) => releaseMatchesType(r, "all"))).toHaveLength(4);
    });
  });

  describe("releaseScanLimit", () => {
    test("without a filter the limit is the window", () => {
      expect(releaseScanLimit(10, "all")).toBe(10);
    });

    test("a filter looks back at least the scan window", () => {
      expect(releaseScanLimit(3, "stable")).toBe(RELEASE_SCAN_WINDOW);
      expect(releaseScanLimit(1, "stable")).toBe(RELEASE_SCAN_WINDOW);
    });

    test("a tag filter widens the window the same way", () => {
      expect(releaseScanLimit(1, "all", true)).toBe(RELEASE_SCAN_WINDOW);
      expect(releaseScanLimit(1, "all", false)).toBe(1);
    });

    test("a limit bigger than the window still wins", () => {
      expect(releaseScanLimit(RELEASE_SCAN_WINDOW + 50, "stable")).toBe(
        RELEASE_SCAN_WINDOW + 50
      );
    });
  });

  describe("release tag patterns", () => {
    test("normalizeReleaseTagPatterns trims, dedupes and drops junk entries", () => {
      expect(
        normalizeReleaseTagPatterns(["  v1.0  ", "", 5, null, "v1.0", "V1.0", "rc"])
      ).toEqual(["v1.0", "rc"]);
    });

    test("an empty or unusable list is absent, not an empty pin", () => {
      // Clearing the box means inherit, so an empty list has to fall through to
      // the next tier rather than pinning "no patterns" here.
      expect(normalizeReleaseTagPatterns([])).toBeUndefined();
      expect(normalizeReleaseTagPatterns(["", "  "])).toBeUndefined();
      expect(normalizeReleaseTagPatterns("v*")).toBeUndefined();
      expect(normalizeReleaseTagPatterns(null)).toBeUndefined();
      expect(normalizeReleaseTagPatterns(undefined)).toBeUndefined();
    });

    test("over-long patterns are dropped and the list is capped", () => {
      expect(
        normalizeReleaseTagPatterns(["x".repeat(MAX_RELEASE_TAG_PATTERN_LENGTH + 1)])
      ).toBeUndefined();
      const many = Array.from(
        { length: MAX_RELEASE_TAG_PATTERNS + 5 },
        (_, index) => `v${index}`
      );
      expect(normalizeReleaseTagPatterns(many)).toHaveLength(MAX_RELEASE_TAG_PATTERNS);
    });

    test("a plain pattern is a whole-tag wildcard, case-insensitive", () => {
      expect(compileReleaseTagPattern("*-rc.*")?.test("V1.0-rc.1")).toBe(true);
      expect(compileReleaseTagPattern("*-rc.*")?.test("v1.0.0")).toBe(false);
      expect(compileReleaseTagPattern("?")?.test("a")).toBe(true);
      expect(compileReleaseTagPattern("?")?.test("ab")).toBe(false);
      expect(compileReleaseTagPattern("RC")?.test("rc")).toBe(true);
    });

    test("a wildcard cannot start or end in the middle of a tag", () => {
      expect(compileReleaseTagPattern("rc")?.test("v1.0-rc.1")).toBe(false);
      expect(compileReleaseTagPattern("*rc*")?.test("v1.0-rc.1")).toBe(true);
    });

    test("dots and brackets are literal in a glob", () => {
      expect(compileReleaseTagPattern("v1.0")?.test("v1.0")).toBe(true);
      expect(compileReleaseTagPattern("v1.0")?.test("v1x0")).toBe(false);
      expect(compileReleaseTagPattern("[bet]")?.test("[bet]")).toBe(true);
      expect(compileReleaseTagPattern("[bet]")?.test("b")).toBe(false);
    });

    test("the slash form is a regular expression", () => {
      const strict = compileReleaseTagPattern("/^v\\d+\\.\\d+\\.\\d+$/");
      expect(strict?.test("v1.2.3")).toBe(true);
      expect(strict?.test("v1.2.3-rc.1")).toBe(false);
      expect(compileReleaseTagPattern("/rc/")?.test("v2.0-rc2")).toBe(true);
    });

    test("a regex keeps its own flags but always ignores case", () => {
      expect(compileReleaseTagPattern("/^V\\d+$/i")?.test("v7")).toBe(true);
      expect(compileReleaseTagPattern("/^V\\d+$/")?.test("v7")).toBe(true);
    });

    test("a pattern that cannot compile is dropped rather than thrown", () => {
      // One typo in a stored pattern must not stop a mirror run.
      expect(compileReleaseTagPattern("/v1(/")).toBeNull();
      expect(compileReleaseTagPattern("")).toBeNull();
      expect(compileReleaseTagPattern(true)).toBeNull();
      expect(compileReleaseTagPatterns(["v*", "/v1(/", ""])).toHaveLength(1);
    });

    test("include restricts, exclude wins when both name a tag", () => {
      const include = compileReleaseTagPatterns(["v*"]);
      const exclude = compileReleaseTagPatterns(["*-rc.*"]);
      expect(releaseMatchesTagFilters("v1.2.3", include, exclude)).toBe(true);
      expect(releaseMatchesTagFilters("next-1.2", include, exclude)).toBe(false);
      expect(releaseMatchesTagFilters("v1.0-rc.1", include, exclude)).toBe(false);
    });

    test("no patterns means every tag passes", () => {
      expect(releaseMatchesTagFilters("anything", [], [])).toBe(true);
      expect(releaseTagMatchesAny("v1", [])).toBe(false);
    });

    test("a release with no tag name still evaluates", () => {
      expect(releaseMatchesTagFilters("", compileReleaseTagPatterns(["*"]), [])).toBe(true);
      expect(releaseMatchesTagFilters("", compileReleaseTagPatterns(["v*"]), [])).toBe(false);
    });
  });

  describe("release tag pattern tiers and overrides", () => {
    test("no tier means no filter", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true }),
        repository: makeRepo(),
      });
      expect(resolved.releaseIncludeTags).toEqual([]);
      expect(resolved.releaseExcludeTags).toEqual([]);
    });

    test("organization beats global, repository beats organization", () => {
      const config = makeConfig({
        mirrorReleases: true,
        releaseExcludeTags: ["*-rc.*"],
      });

      expect(
        resolveMirrorOptions({ config, repository: makeRepo() }).releaseExcludeTags
      ).toEqual(["*-rc.*"]);

      expect(
        resolveMirrorOptions({
          config,
          repository: makeRepo(),
          orgOverrides: { releaseExcludeTags: ["*-beta.*"] },
        }).releaseExcludeTags
      ).toEqual(["*-beta.*"]);

      expect(
        resolveMirrorOptions({
          config,
          repository: makeRepo({
            mirrorOverrides: { releaseExcludeTags: ["*-alpha.*"] },
          }),
          orgOverrides: { releaseExcludeTags: ["*-beta.*"] },
        }).releaseExcludeTags
      ).toEqual(["*-alpha.*"]);
    });

    test("an empty repository list inherits rather than clearing", () => {
      // The documented consequence of "an empty list is not a pin": a repository
      // cannot switch off a pattern its organization set.
      expect(
        resolveMirrorOptions({
          config: makeConfig({ mirrorReleases: true, releaseExcludeTags: ["*-rc.*"] }),
          repository: makeRepo({ mirrorOverrides: { releaseExcludeTags: [] } }),
        }).releaseExcludeTags
      ).toEqual(["*-rc.*"]);
    });

    test("include and exclude resolve independently of each other", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseIncludeTags: ["v*"] }),
        repository: makeRepo({
          mirrorOverrides: { releaseExcludeTags: ["*-rc.*"] },
        }),
      });
      expect(resolved.releaseIncludeTags).toEqual(["v*"]);
      expect(resolved.releaseExcludeTags).toEqual(["*-rc.*"]);
    });

    test("junk entries are dropped one at a time, not the whole list", () => {
      expect(
        resolveMirrorOptions({
          config: makeConfig({ mirrorReleases: true }),
          repository: makeRepo({
            mirrorOverrides: { releaseIncludeTags: ["v*", 7, "", "V*", null] },
          }),
        }).releaseIncludeTags
      ).toEqual(["v*"]);
    });

    test("a pinned pattern list counts as an override", () => {
      expect(hasMirrorOverrides({ releaseExcludeTags: ["v*"] })).toBe(true);
      expect(listOverriddenKeys({ releaseIncludeTags: ["v*"] })).toEqual([
        "releaseIncludeTags",
      ]);
    });

    test("empty and junk pattern lists do not count", () => {
      expect(hasMirrorOverrides({ releaseIncludeTags: [] })).toBe(false);
      expect(hasMirrorOverrides({ releaseExcludeTags: null })).toBe(false);
      expect(listOverriddenKeys({ releaseExcludeTags: [7, ""] })).toEqual([]);
    });

    test("normalizeMirrorOverrides keeps the usable patterns", () => {
      expect(
        normalizeMirrorOverrides({ releaseIncludeTags: [" v* ", "v*", 5] })
      ).toEqual({ releaseIncludeTags: ["v*"] });
      expect(normalizeMirrorOverrides({ releaseIncludeTags: [] })).toBeNull();
    });

    test("a junk pattern entry does not take the rest of the overrides with it", () => {
      expect(
        parseMirrorOverrides({ releaseIncludeTags: ["v*", 7], lfs: false })
      ).toEqual({ releaseIncludeTags: ["v*", 7], lfs: false });
      expect(
        normalizeMirrorOverrides({ releaseIncludeTags: ["v*", 7], lfs: false })
      ).toEqual({ releaseIncludeTags: ["v*"], lfs: false });
    });

    test("the pattern keys are their own group, with labels", () => {
      expect(MIRROR_OVERRIDE_PATTERN_KEYS).toEqual([
        "releaseIncludeTags",
        "releaseExcludeTags",
      ]);
      expect(MIRROR_OVERRIDE_KEYS).not.toContain("releaseIncludeTags");
      expect(MIRROR_OVERRIDE_LIMIT_KEYS).not.toContain("releaseExcludeTags");
      expect(MIRROR_OVERRIDE_CHOICE_KEYS).not.toContain("releaseExcludeTags");
      for (const key of MIRROR_OVERRIDE_PATTERN_KEYS) {
        expect(MIRROR_OVERRIDE_LABELS[key]).toBeTruthy();
      }
    });

    test("mirrorOptionsToFlags exposes the lists for the dialog hints", () => {
      expect(mirrorOptionsToFlags({ mirrorReleases: true }).releaseIncludeTags).toEqual([]);
      expect(
        mirrorOptionsToFlags({ releaseExcludeTags: ["*-rc.*"] }).releaseExcludeTags
      ).toEqual(["*-rc.*"]);
    });

    test("the pattern boxes are gated exactly like the release limit", () => {
      const releasesOff = getMirrorOverrideGating({
        targetKind: "repository",
        effective: { mirrorReleases: false },
      });
      expect(releasesOff.releaseIncludeTags).toBe(MIRROR_GATING_REASONS.releasesOff);
      expect(releasesOff.releaseExcludeTags).toBe(MIRROR_GATING_REASONS.releasesOff);

      const starred = getMirrorOverrideGating({
        targetKind: "repository",
        isStarred: true,
        starredCodeOnly: true,
        effective: { mirrorReleases: true },
      });
      expect(starred.releaseIncludeTags).toBe(MIRROR_GATING_REASONS.starredCodeOnly);

      const pushTarget = getMirrorOverrideGating({
        targetKind: "repository",
        effective: { mirrorReleases: true },
        destinationProvider: "gitlab",
      });
      expect(pushTarget.releaseIncludeTags).toBe(MIRROR_GATING_REASONS.pushTarget);
      expect(pushTarget.releaseExcludeTags).toBe(MIRROR_GATING_REASONS.pushTarget);

      const editable = getMirrorOverrideGating({
        targetKind: "organization",
        effective: { mirrorReleases: true },
      });
      expect(editable.releaseIncludeTags).toBeUndefined();
      expect(editable.releaseExcludeTags).toBeUndefined();
    });
  });

  describe("resolveMirrorOptions", () => {
    test("defaults to every release when no tier pins a type", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true }),
        repository: makeRepo(),
      });
      expect(resolved.releaseType).toBe(DEFAULT_RELEASE_TYPE);
      expect(resolved.releaseType).toBe("all");
    });

    test("the global value applies when nothing overrides it", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseType: "stable" }),
        repository: makeRepo(),
      });
      expect(resolved.releaseType).toBe("stable");
    });

    test("organization beats global, repository beats organization", () => {
      const config = makeConfig({ mirrorReleases: true, releaseType: "all" });

      expect(
        resolveMirrorOptions({
          config,
          repository: makeRepo(),
          orgOverrides: { releaseType: "stable" },
        }).releaseType
      ).toBe("stable");

      expect(
        resolveMirrorOptions({
          config,
          repository: makeRepo({ mirrorOverrides: { releaseType: "all" } }),
          orgOverrides: { releaseType: "stable" },
        }).releaseType
      ).toBe("all");
    });

    test("null in an override means inherit", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseType: "stable" }),
        repository: makeRepo({ mirrorOverrides: { releaseType: null } }),
        orgOverrides: { releaseType: null },
      });
      expect(resolved.releaseType).toBe("stable");
    });

    test("an unusable value falls through to the next tier", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseType: "all" }),
        repository: makeRepo({ mirrorOverrides: { releaseType: "beta" } }),
        orgOverrides: { releaseType: "stable" },
      });
      expect(resolved.releaseType).toBe("stable");
    });

    test("a tier with nothing usable lands on the default rather than a filter", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseType: "weekly" }),
        repository: makeRepo({ mirrorOverrides: { releaseType: "beta" } }),
      });
      expect(resolved.releaseType).toBe(DEFAULT_RELEASE_TYPE);
    });

    test("the release type is independent of the release limit", () => {
      const resolved = resolveMirrorOptions({
        config: makeConfig({ mirrorReleases: true, releaseLimit: 3 }),
        repository: makeRepo({ mirrorOverrides: { releaseType: "stable" } }),
      });
      expect(resolved.releaseLimit).toBe(3);
      expect(resolved.releaseType).toBe("stable");
    });
  });

  describe("override helpers", () => {
    test("a pinned release type counts as an override", () => {
      expect(hasMirrorOverrides({ releaseType: "stable" })).toBe(true);
      expect(listOverriddenKeys({ releaseType: "all" })).toEqual(["releaseType"]);
    });

    test("null and unusable values do not count", () => {
      expect(hasMirrorOverrides({ releaseType: null })).toBe(false);
      expect(hasMirrorOverrides({ releaseType: "beta" })).toBe(false);
      expect(listOverriddenKeys({ releaseType: "beta" })).toEqual([]);
    });

    test("normalizeMirrorOverrides folds case and drops junk", () => {
      expect(normalizeMirrorOverrides({ releaseType: "Stable" })).toEqual({
        releaseType: "stable",
      });
      expect(normalizeMirrorOverrides({ releaseType: "beta" })).toBeNull();
      expect(
        normalizeMirrorOverrides({ releaseType: null, lfs: true })
      ).toEqual({ lfs: true });
    });

    test("a junk release type does not take the rest of the overrides with it", () => {
      // The stored column is loose on purpose: one bad field must not make the
      // whole object unparseable and silently drop the LFS opt-out next to it.
      expect(parseMirrorOverrides({ releaseType: "beta", lfs: false })).toEqual({
        releaseType: "beta",
        lfs: false,
      });
      expect(normalizeMirrorOverrides({ releaseType: "beta", lfs: false })).toEqual({
        lfs: false,
      });
    });

    test("the choice keys and labels agree", () => {
      expect(MIRROR_OVERRIDE_CHOICE_KEYS).toEqual(["releaseType"]);
      for (const key of MIRROR_OVERRIDE_CHOICE_KEYS) {
        expect(MIRROR_OVERRIDE_LABELS[key]).toBeTruthy();
      }
    });

    test("the choice keys are not walked as flags or limits", () => {
      expect(MIRROR_OVERRIDE_KEYS).not.toContain("releaseType");
      expect(MIRROR_OVERRIDE_LIMIT_KEYS).not.toContain("releaseType");
    });
  });

  describe("mirrorOptionsToFlags", () => {
    test("defaults to every release when the API sends no type", () => {
      expect(mirrorOptionsToFlags({ mirrorReleases: true }).releaseType).toBe("all");
      expect(
        mirrorOptionsToFlags({ mirrorReleases: true, releaseType: null as any }).releaseType
      ).toBe("all");
    });

    test("passes the stored value through", () => {
      expect(mirrorOptionsToFlags({ releaseType: "stable" }).releaseType).toBe("stable");
      // A value from a release that no longer offers this kind lands on the
      // default instead of turning into a filter nothing asked for.
      expect(mirrorOptionsToFlags({ releaseType: "prerelease" as any }).releaseType).toBe(
        "all"
      );
    });
  });

  describe("getMirrorOverrideGating", () => {
    test("the release type is disabled with the release limit when releases are off", () => {
      const gating = getMirrorOverrideGating({
        targetKind: "repository",
        effective: { mirrorReleases: false },
      });
      expect(gating.releaseType).toBe(MIRROR_GATING_REASONS.releasesOff);
      expect(gating.releaseLimit).toBe(MIRROR_GATING_REASONS.releasesOff);
    });

    test("the release type inherits the starred reason", () => {
      const gating = getMirrorOverrideGating({
        targetKind: "repository",
        isStarred: true,
        starredCodeOnly: true,
        effective: { mirrorReleases: true },
      });
      expect(gating.releaseType).toBe(MIRROR_GATING_REASONS.starredCodeOnly);
    });

    test("the release type is editable while releases are on", () => {
      const gating = getMirrorOverrideGating({
        targetKind: "organization",
        effective: { mirrorReleases: true },
      });
      expect(gating.releaseType).toBeUndefined();
    });

    test("a push target disables the release type", () => {
      const gating = getMirrorOverrideGating({
        targetKind: "repository",
        effective: { mirrorReleases: true },
        destinationProvider: "github",
      });
      expect(gating.releaseType).toBe(MIRROR_GATING_REASONS.pushTarget);
    });
  });
});
