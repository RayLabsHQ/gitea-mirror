/**
 * Regression test for the #334 sibling bug — labels silently dropped on issue update.
 *
 * Gitea/Forgejo's `EditIssueOption` has no `labels` field (only `CreateIssueOption`
 * does), so a `labels` key in a `PATCH .../issues/{index}` body is silently ignored.
 * The old code put `labels` in the update PATCH, so label changes never propagated
 * onto already-mirrored issues. The fix builds the edit body WITHOUT labels
 * (`buildGiteaIssueEditPayload`) and reconciles labels separately through the
 * sub-resource `PUT .../issues/{index}/labels` (`buildGiteaIssueLabelsPayload`).
 *
 * Verified live against Gitea 1.24.7: PATCH with `labels` leaves the issue's labels
 * unchanged; PUT to the labels sub-resource replaces them. Confirmed end-to-end that
 * a drifted (label-less) mirrored issue reconciles back to its GitHub label set.
 */

import { describe, test, expect } from "bun:test";
import { buildGiteaIssueEditPayload, buildGiteaIssueLabelsPayload } from "@/lib/gitea";

describe("buildGiteaIssueEditPayload (#334 sibling)", () => {
  test("edit body never carries `labels` (Gitea's EditIssueOption ignores it)", () => {
    const payload = buildGiteaIssueEditPayload({
      title: "[GH-ISSUE #1] Fix the thing",
      body: "desc",
      closed: false,
    });
    expect(payload).not.toHaveProperty("labels");
    expect(payload).toEqual({
      title: "[GH-ISSUE #1] Fix the thing",
      body: "desc",
      state: "open",
    });
  });

  test("maps the closed flag to Gitea's `state`", () => {
    expect(buildGiteaIssueEditPayload({ title: "t", body: "b", closed: true }).state).toBe("closed");
    expect(buildGiteaIssueEditPayload({ title: "t", body: "b", closed: false }).state).toBe("open");
  });
});

describe("buildGiteaIssueLabelsPayload (#334 sibling)", () => {
  test("replaces the full label set with the resolved Gitea label ids", () => {
    expect(buildGiteaIssueLabelsPayload([7, 9])).toEqual({ labels: [7, 9] });
  });

  test("sends an empty set so upstream label removals propagate", () => {
    expect(buildGiteaIssueLabelsPayload([])).toEqual({ labels: [] });
  });

  test("treats a missing id list as an empty set (defensive)", () => {
    expect(buildGiteaIssueLabelsPayload(undefined as any)).toEqual({ labels: [] });
  });
});
