import { describe, expect, test } from "bun:test";
import type { SourceApiRecord } from "@/types/config";
import { resolveOrganizationSource } from "./organization-presentation";

function source(overrides: Partial<SourceApiRecord>): SourceApiRecord {
  return {
    id: "s1",
    name: "GitHub",
    provider: "github",
    url: "",
    username: "octo",
    hasToken: false,
    authType: "pat",
    enabled: true,
    repositoryCount: 0,
    locked: false,
    ...overrides,
  };
}

describe("resolveOrganizationSource public only flag", () => {
  const resolve = (pinned: SourceApiRecord) =>
    resolveOrganizationSource({ sourceId: "s1" }, [pinned], "github", "https://github.com");

  test("a pinned source without a token is public only", () => {
    expect(resolve(source({})).isPublicOnlySource).toBe(true);
  });

  test("a pinned source with a saved token is not", () => {
    expect(resolve(source({ hasToken: true })).isPublicOnlySource).toBe(false);
  });

  test("a GitHub App source has no token but is not public only", () => {
    expect(resolve(source({ authType: "app", appId: "1", installationId: "2" })).isPublicOnlySource).toBe(false);
  });

  test("an unpinned organization is not public only", () => {
    expect(
      resolveOrganizationSource({ sourceId: null }, [], "github", "https://github.com").isPublicOnlySource
    ).toBe(false);
  });
});
