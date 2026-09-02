import { describe, expect, test } from "bun:test";
import {
  SOURCE_PROVIDER_DEFAULT_URLS,
  getRepositorySource,
  isRepositoryFromConfiguredSource,
  isSourceProviderKind,
  isValidSourceUrl,
  normalizeSourceProviderKind,
  normalizeSourceUrl,
  sourceHostOf,
} from "./kinds";

describe("normalizeSourceProviderKind", () => {
  test("accepts the three kinds and defaults everything else to GitHub", () => {
    expect(normalizeSourceProviderKind("github")).toBe("github");
    expect(normalizeSourceProviderKind("gitlab")).toBe("gitlab");
    expect(normalizeSourceProviderKind("gitea")).toBe("gitea");
    expect(normalizeSourceProviderKind(undefined)).toBe("github");
    expect(normalizeSourceProviderKind(null)).toBe("github");
    expect(normalizeSourceProviderKind("bitbucket")).toBe("github");
    expect(normalizeSourceProviderKind(42)).toBe("github");
  });

  test("treats forgejo and codeberg as the Gitea kind", () => {
    expect(normalizeSourceProviderKind("forgejo")).toBe("gitea");
    expect(normalizeSourceProviderKind("codeberg")).toBe("gitea");
    expect(isSourceProviderKind("forgejo")).toBe(false);
  });
});

describe("normalizeSourceUrl", () => {
  test("falls back to the provider default when empty", () => {
    expect(normalizeSourceUrl("", "gitlab")).toBe("https://gitlab.com");
    expect(normalizeSourceUrl(undefined, "gitea")).toBe("https://codeberg.org");
    expect(normalizeSourceUrl(null, "github")).toBe(SOURCE_PROVIDER_DEFAULT_URLS.github);
  });

  test("adds https, lowercases the host and strips trailing slashes", () => {
    expect(normalizeSourceUrl("gitlab.example.com/", "gitlab")).toBe("https://gitlab.example.com");
    expect(normalizeSourceUrl("HTTPS://Codeberg.org///", "gitea")).toBe("https://codeberg.org");
    expect(normalizeSourceUrl("  http://gitea.local:3000/gitea/ ", "gitea")).toBe(
      "http://gitea.local:3000/gitea"
    );
  });

  test("rejects non http schemes and garbage", () => {
    expect(normalizeSourceUrl("ftp://gitlab.example.com", "gitlab")).toBe("https://gitlab.com");
    expect(normalizeSourceUrl("not a url", "gitlab")).toBe("https://gitlab.com");
  });
});

describe("isValidSourceUrl", () => {
  test("accepts http(s) URLs with or without a scheme", () => {
    expect(isValidSourceUrl("https://gitlab.example.com")).toBe(true);
    expect(isValidSourceUrl("gitea.local:3000")).toBe(true);
  });

  test("rejects empty, non http and unparseable values", () => {
    expect(isValidSourceUrl("")).toBe(false);
    expect(isValidSourceUrl("ftp://x")).toBe(false);
    expect(isValidSourceUrl("not a url")).toBe(false);
  });
});

describe("getRepositorySource / isRepositoryFromConfiguredSource", () => {
  test("rows from before the source columns count as GitHub", () => {
    expect(getRepositorySource({})).toEqual({ provider: "github", url: "https://github.com" });
    expect(
      isRepositoryFromConfiguredSource({}, { provider: "github", url: "https://github.com" })
    ).toBe(true);
    expect(
      isRepositoryFromConfiguredSource({}, { provider: "gitlab", url: "https://gitlab.com" })
    ).toBe(false);
  });

  test("compares normalized URLs so a trailing slash does not split a source", () => {
    const row = { sourceProvider: "gitlab", sourceUrl: "https://GitLab.example.com/" };
    expect(getRepositorySource(row)).toEqual({
      provider: "gitlab",
      url: "https://gitlab.example.com",
    });
    expect(
      isRepositoryFromConfiguredSource(row, {
        provider: "gitlab",
        url: "https://gitlab.example.com",
      })
    ).toBe(true);
    expect(
      isRepositoryFromConfiguredSource(row, { provider: "gitlab", url: "https://gitlab.com" })
    ).toBe(false);
  });
});

describe("sourceHostOf", () => {
  test("returns the lowercase host including a port", () => {
    expect(sourceHostOf("https://Codeberg.org")).toBe("codeberg.org");
    expect(sourceHostOf("http://gitea.local:3000/gitea")).toBe("gitea.local:3000");
    expect(sourceHostOf("nonsense")).toBe("");
  });
});
