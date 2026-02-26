import { describe, expect, it } from "bun:test";
import { isMirrorableGitHubRepo } from "@/lib/repo-eligibility";

describe("isMirrorableGitHubRepo", () => {
  it("returns false for disabled repos", () => {
    expect(isMirrorableGitHubRepo({ isDisabled: true })).toBe(false);
  });

  it("returns true for enabled repos", () => {
    expect(isMirrorableGitHubRepo({ isDisabled: false })).toBe(true);
  });

  it("returns true when disabled flag is absent", () => {
    expect(isMirrorableGitHubRepo({})).toBe(true);
  });
});

