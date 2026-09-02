import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RELEASE_LIMIT,
  getMirrorOverrideGating,
  hasMirrorOverrides,
  listOverriddenKeys,
  MIRROR_GATING_REASONS,
  MIRROR_OVERRIDE_KEYS,
  MIRROR_OVERRIDE_LABELS,
  MIRROR_OVERRIDE_LIMIT_KEYS,
  mirrorOptionsToFlags,
  normalizeMirrorOverrides,
  normalizeReleaseAssetLimit,
  normalizeReleaseLimit,
  parseMirrorOverrides,
  releaseGetsAssets,
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

    const stored = dbConfig.giteaConfig as Record<string, boolean>;
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
