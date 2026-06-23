/**
 * Unit tests for release reconciliation logic — regression for #310.
 *
 * Root-cause verdict: Theory A (not Theory B).
 *
 * The old `needsRecreation` check compared published_at-based expected indices
 * against Gitea's API order (which mirrors sort by tag-commit-date, not
 * published_at). For repos where published_at order permanently disagrees with
 * tag-commit-date order, `currentExpectedIdx < nextExpectedIdx` evaluates true
 * on every single sync, triggering delete-and-recreate forever.
 *
 * Discriminating evidence — unaconfig_dart fixture:
 *   v0.1.1 published_at 2024-01-13T23:44 (earlier) → expectedOrder index 0
 *   v0.1.0 published_at 2024-01-16T00:23 (later)   → expectedOrder index 1
 *   v0.1.0 tagged       2024-01-13T23:30 (earlier tag commit)
 *   v0.1.1 tagged       2024-01-13T23:42 (later tag commit)
 *   → Gitea tag-commit order: [v0.1.1, v0.1.0] (v0.1.1 has newer commit)
 *   → Old check: currentExpectedIdx(v0.1.1)=0 < nextExpectedIdx(v0.1.0)=1  → TRUE
 *   → needsRecreation fires on every sync, forever.
 *
 * Theory B (operator inversion) would fire for ALL repos with >1 release, but
 * field evidence shows only ~2 of 150 repos are affected — ruling it out.
 *
 * Fix: replaced `needsRecreation` machinery with set-based reconciliation via
 * `classifyReleasesForReconciliation`. Releases are created when missing, skipped
 * (or PATCH-updated if content drifted) when present. No deletions for ordering.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyReleasesForReconciliation,
  classifyAssetsForReconciliation,
} from "@/lib/gitea";

describe("classifyReleasesForReconciliation", () => {
  describe("normal repo — published_at order matches tag-commit order", () => {
    it("creates releases missing in Gitea", () => {
      const github = ["v1.0.0", "v1.1.0", "v1.2.0"];
      const gitea: string[] = [];

      const { toCreate, toSkip } = classifyReleasesForReconciliation(github, gitea);

      expect(toCreate).toEqual(["v1.0.0", "v1.1.0", "v1.2.0"]);
      expect(toSkip).toEqual([]);
    });

    it("skips releases already present in Gitea", () => {
      const github = ["v1.0.0", "v1.1.0", "v1.2.0"];
      const gitea = ["v1.0.0", "v1.1.0", "v1.2.0"];

      const { toCreate, toSkip } = classifyReleasesForReconciliation(github, gitea);

      expect(toCreate).toEqual([]);
      expect(toSkip).toEqual(["v1.0.0", "v1.1.0", "v1.2.0"]);
    });

    it("creates missing releases while skipping existing ones", () => {
      const github = ["v1.0.0", "v1.1.0", "v1.2.0"];
      const gitea = ["v1.0.0", "v1.2.0"]; // v1.1.0 is missing

      const { toCreate, toSkip } = classifyReleasesForReconciliation(github, gitea);

      expect(toCreate).toEqual(["v1.1.0"]);
      expect(toSkip).toEqual(["v1.0.0", "v1.2.0"]);
    });

    it("does NOT produce any deletions — order mismatches are ignored", () => {
      // Even if Gitea has them in a different order, the function never suggests deletion
      const github = ["v1.0.0", "v1.1.0"];
      const gitea = ["v1.1.0", "v1.0.0"]; // reversed order from Gitea

      const { toCreate, toSkip } = classifyReleasesForReconciliation(github, gitea);

      expect(toCreate).toEqual([]);
      expect(toSkip).toHaveLength(2);
      expect(toSkip).toContain("v1.0.0");
      expect(toSkip).toContain("v1.1.0");
    });
  });

  describe("unaconfig_dart regression — published_at order disagrees with tag-commit order (#310)", () => {
    // v0.1.0: tagged 2024-01-13T23:30, published_at 2024-01-16T00:23 (published AFTER v0.1.1)
    // v0.1.1: tagged 2024-01-13T23:42, published_at 2024-01-13T23:44 (published BEFORE v0.1.0)
    //
    // Gitea display order (by tag-commit date): [v0.1.1, v0.1.0]  (v0.1.1 tagged later)
    // GitHub published_at order (oldest first):  [v0.1.1, v0.1.0]  (v0.1.1 published earlier)
    // Wait — in this specific case the orders AGREE. The inversion scenario is:
    //   GitHub sorts descending (newest first): [v0.1.0, v0.1.1]
    //   Gitea API returns by tag-commit DESC:   [v0.1.1, v0.1.0]
    //   Old expectedOrder (ascending published): v0.1.1→0, v0.1.0→1
    //   Check for [v0.1.1, v0.1.0]: current=v0.1.1(idx=0) < next=v0.1.0(idx=1) → TRUE every time

    it("does NOT trigger recreation when published_at order and tag-commit order disagree", () => {
      // Both releases already in Gitea (as they would be after first successful sync).
      // Old code would fire needsRecreation=true here on every subsequent sync.
      // New code: set-based check — both present → toCreate is empty → no deletions.
      const github = ["v0.1.0", "v0.1.1"]; // GitHub API returns newest published_at first
      const gitea = ["v0.1.1", "v0.1.0"];  // Gitea tag-commit order (v0.1.1 tagged later)

      const { toCreate, toSkip } = classifyReleasesForReconciliation(github, gitea);

      expect(toCreate).toEqual([]); // nothing to create
      expect(toSkip).toHaveLength(2);
      expect(toSkip).toContain("v0.1.0");
      expect(toSkip).toContain("v0.1.1");
    });

    it("creates v0.1.0 and v0.1.1 when Gitea has no releases yet (first sync)", () => {
      const github = ["v0.1.0", "v0.1.1"];
      const gitea: string[] = [];

      const { toCreate, toSkip } = classifyReleasesForReconciliation(github, gitea);

      expect(toCreate).toEqual(["v0.1.0", "v0.1.1"]);
      expect(toSkip).toEqual([]);
    });

    it("only creates the missing release when one of the two already exists", () => {
      const github = ["v0.1.0", "v0.1.1"];
      const gitea = ["v0.1.1"]; // only v0.1.1 was created so far

      const { toCreate, toSkip } = classifyReleasesForReconciliation(github, gitea);

      expect(toCreate).toEqual(["v0.1.0"]);
      expect(toSkip).toEqual(["v0.1.1"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty GitHub releases list", () => {
      const { toCreate, toSkip } = classifyReleasesForReconciliation([], ["v1.0.0"]);
      expect(toCreate).toEqual([]);
      expect(toSkip).toEqual([]);
    });

    it("handles both lists empty", () => {
      const { toCreate, toSkip } = classifyReleasesForReconciliation([], []);
      expect(toCreate).toEqual([]);
      expect(toSkip).toEqual([]);
    });

    it("ignores Gitea releases that are not in the GitHub set (orphans, handled by retention cleanup)", () => {
      const github = ["v1.0.0"];
      const gitea = ["v1.0.0", "v0.9.0"]; // v0.9.0 is an orphan not in GitHub's limited set

      const { toCreate, toSkip } = classifyReleasesForReconciliation(github, gitea);

      expect(toCreate).toEqual([]);
      expect(toSkip).toEqual(["v1.0.0"]);
      // v0.9.0 not mentioned in either output — handled by retention cleanup, not here
    });
  });
});

/**
 * Asset reconciliation — regression for #331.
 *
 * Root cause: assets were uploaded only on the create path. When a Gitea release
 * already existed (every re-sync, or after an interrupted first upload), the update
 * path PATCHed the body and `continue`d without ever touching assets — so a release
 * that existed without its full asset set stayed permanently asset-less and re-syncing
 * could never heal it. Reproduced on a real Forgejo pull-mirror: GitHub release with
 * two 35-40MB binaries → Gitea release with 0 assets → re-sync logged "Updating
 * existing release" and left it at 0.
 *
 * Fix: reconcile assets idempotently on both paths via classifyAssetsForReconciliation.
 */
describe("classifyAssetsForReconciliation", () => {
  it("uploads all assets when the Gitea release has none (the #331 broken state)", () => {
    const github = [
      { name: "base.zip", size: 40_264_954 },
      { name: "extras.zip", size: 37_098_528 },
    ];
    const gitea: Array<{ id: number; name: string; size: number }> = [];

    const { toUpload, toSkip } = classifyAssetsForReconciliation(github, gitea);

    expect(toSkip).toEqual([]);
    expect(toUpload).toEqual([
      { name: "base.zip", replaceAssetId: null },
      { name: "extras.zip", replaceAssetId: null },
    ]);
  });

  it("backfills only the missing asset when one already exists", () => {
    const github = [
      { name: "base.zip", size: 40_264_954 },
      { name: "extras.zip", size: 37_098_528 },
    ];
    const gitea = [{ id: 9, name: "base.zip", size: 40_264_954 }];

    const { toUpload, toSkip } = classifyAssetsForReconciliation(github, gitea);

    expect(toSkip).toEqual(["base.zip"]);
    expect(toUpload).toEqual([{ name: "extras.zip", replaceAssetId: null }]);
  });

  it("is idempotent — skips everything when all assets already match by name+size", () => {
    const github = [
      { name: "base.zip", size: 40_264_954 },
      { name: "extras.zip", size: 37_098_528 },
    ];
    const gitea = [
      { id: 9, name: "base.zip", size: 40_264_954 },
      { id: 10, name: "extras.zip", size: 37_098_528 },
    ];

    const { toUpload, toSkip } = classifyAssetsForReconciliation(github, gitea);

    expect(toUpload).toEqual([]);
    expect(toSkip).toEqual(["base.zip", "extras.zip"]);
  });

  it("replaces an asset whose size changed upstream (re-upload over the stale copy)", () => {
    const github = [{ name: "firmware.bin", size: 2048 }];
    const gitea = [{ id: 42, name: "firmware.bin", size: 1024 }]; // truncated/stale

    const { toUpload, toSkip } = classifyAssetsForReconciliation(github, gitea);

    expect(toSkip).toEqual([]);
    expect(toUpload).toEqual([{ name: "firmware.bin", replaceAssetId: 42 }]);
  });

  it("handles a release with no GitHub assets", () => {
    const { toUpload, toSkip } = classifyAssetsForReconciliation(
      [],
      [{ id: 1, name: "leftover.zip", size: 10 }]
    );
    expect(toUpload).toEqual([]);
    expect(toSkip).toEqual([]);
  });
});
