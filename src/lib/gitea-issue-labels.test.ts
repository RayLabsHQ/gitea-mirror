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
import {
  buildGiteaIssueEditPayload,
  buildGiteaIssueLabelsPayload,
  buildGiteaMilestoneEditPayload,
  giteaMilestoneEdit,
  resolveGiteaMilestoneId,
} from "@/lib/gitea";

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

describe("issue milestones (#460)", () => {
  const ids = new Map([["v1.0", 7]]);

  test("the edit body carries a milestone only when one is given", () => {
    expect(buildGiteaIssueEditPayload({ title: "t", body: "b", closed: false })).not.toHaveProperty(
      "milestone"
    );
    expect(
      buildGiteaIssueEditPayload({ title: "t", body: "b", closed: false, milestone: 7 }).milestone
    ).toBe(7);
    // 0 is how Gitea clears a milestone, so it has to survive.
    expect(
      buildGiteaIssueEditPayload({ title: "t", body: "b", closed: false, milestone: 0 }).milestone
    ).toBe(0);
  });

  test("resolves the Gitea id by title, 0 for none, undefined when unknown", () => {
    expect(resolveGiteaMilestoneId(ids, { title: "v1.0" })).toBe(7);
    expect(resolveGiteaMilestoneId(ids, null)).toBe(0);
    expect(resolveGiteaMilestoneId(ids, { title: "missing" })).toBeUndefined();
    expect(resolveGiteaMilestoneId(undefined, { title: "v1.0" })).toBeUndefined();
    expect(resolveGiteaMilestoneId(undefined, null)).toBeUndefined();
  });

  test("only edits when the issue carries a different milestone", () => {
    expect(giteaMilestoneEdit({ milestone: null }, ids, { title: "v1.0" })).toBe(7);
    expect(giteaMilestoneEdit({ milestone: { id: 7 } }, ids, { title: "v1.0" })).toBeUndefined();
    expect(giteaMilestoneEdit({ milestone: { id: 7 } }, ids, null)).toBe(0);
    expect(giteaMilestoneEdit({}, ids, null)).toBeUndefined();
    expect(giteaMilestoneEdit({ milestone: { id: 7 } }, undefined, null)).toBeUndefined();
  });

  test("never clears a milestone made in Gitea alone", () => {
    // 42 is not in the map: no GitHub milestone has its title.
    expect(giteaMilestoneEdit({ milestone: { id: 42 } }, ids, null)).toBeUndefined();
    // GitHub does name a milestone, so it wins over the Gitea-only one.
    expect(giteaMilestoneEdit({ milestone: { id: 42 } }, ids, { title: "v1.0" })).toBe(7);
  });
});

describe("buildGiteaMilestoneEditPayload (#460 follow-up)", () => {
  test("no edit when state, due day and description match", () => {
    expect(
      buildGiteaMilestoneEditPayload(
        // Created from GitHub: Gitea keeps the instant, shown in its own zone.
        { state: "open", due_on: "2026-11-01T00:00:00-07:00", description: "d" },
        { state: "open", due_on: "2026-11-01T07:00:00Z", description: "d" }
      )
    ).toBeNull();
    expect(
      buildGiteaMilestoneEditPayload(
        // Edited through the API: moved to the end of the day.
        { state: "closed", due_on: "2026-12-15T23:59:59+09:00", description: null },
        { state: "closed", due_on: "2026-12-15T08:00:00Z", description: null }
      )
    ).toBeNull();
    // Year 9999 is how Gitea stores no deadline.
    expect(
      buildGiteaMilestoneEditPayload(
        { state: "open", due_on: "9999-12-31T23:59:59-08:00", description: "" },
        { state: "open", due_on: null, description: "" }
      )
    ).toBeNull();
  });

  test("carries over a close, a due date and a description", () => {
    expect(
      buildGiteaMilestoneEditPayload(
        { state: "open", due_on: null, description: "old" },
        { state: "closed", due_on: "2026-12-15T08:00:00Z", description: "new" }
      )
    ).toEqual({ state: "closed", due_on: "2026-12-15T12:00:00Z", description: "new" });
  });

  test("clears a removed due date with Gitea's no-deadline value", () => {
    expect(
      buildGiteaMilestoneEditPayload(
        { state: "open", due_on: "2026-11-01T00:00:00-07:00", description: "" },
        { state: "open", due_on: null, description: "" }
      )
    ).toEqual({ due_on: "9999-12-31T00:00:00Z" });
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
