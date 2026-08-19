import { describe, expect, test } from "bun:test";
import {
  hasMirrorOverrides,
  listOverriddenKeys,
  normalizeMirrorOverrides,
  parseMirrorOverrides,
  resolveMirrorOptions,
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
