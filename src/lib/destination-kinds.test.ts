import { describe, expect, test } from "bun:test";
import {
  isBetaDestinationProvider,
  describeDestination,
  destinationHostOf,
  getRepositoryDestination,
  isDestinationProviderKind,
  isPushDestinationKind,
  isRepositoryOnConfiguredDestination,
  normalizeDestinationBaseUrl,
  normalizeDestinationProviderKind,
} from "./destination-kinds";

describe("destination kinds", () => {
  test("Gitea is the supported default; every other destination is beta", () => {
    expect(isBetaDestinationProvider("gitea")).toBe(false);
    expect(isBetaDestinationProvider("forgejo")).toBe(true);
    expect(isBetaDestinationProvider("github")).toBe(true);
    expect(isBetaDestinationProvider("gitlab")).toBe(true);
  });

  test("recognizes the four kinds and maps codeberg to forgejo", () => {
    expect(isDestinationProviderKind("gitea")).toBe(true);
    expect(isDestinationProviderKind("forgejo")).toBe(true);
    expect(isDestinationProviderKind("github")).toBe(true);
    expect(isDestinationProviderKind("gitlab")).toBe(true);
    expect(isDestinationProviderKind("bitbucket")).toBe(false);
    expect(normalizeDestinationProviderKind("codeberg")).toBe("forgejo");
    expect(normalizeDestinationProviderKind(undefined)).toBe("gitea");
    expect(normalizeDestinationProviderKind("nonsense")).toBe("gitea");
  });

  test("only GitHub and GitLab are push targets", () => {
    expect(isPushDestinationKind("github")).toBe(true);
    expect(isPushDestinationKind("gitlab")).toBe(true);
    expect(isPushDestinationKind("gitea")).toBe(false);
    expect(isPushDestinationKind("forgejo")).toBe(false);
  });

  test("normalizes base URLs and falls back to the public instance for hosted targets", () => {
    expect(normalizeDestinationBaseUrl("", "github")).toBe("https://github.com");
    expect(normalizeDestinationBaseUrl(undefined, "gitlab")).toBe("https://gitlab.com");
    expect(normalizeDestinationBaseUrl("", "gitea")).toBe("");
    expect(normalizeDestinationBaseUrl("GitLab.example.com/", "gitlab")).toBe("https://gitlab.example.com");
    expect(normalizeDestinationBaseUrl("https://ghe.example.com/api/", "github")).toBe("https://ghe.example.com/api");
    expect(normalizeDestinationBaseUrl("ftp://nope", "github")).toBe("https://github.com");
    expect(destinationHostOf("https://GitHub.com/x")).toBe("github.com");
  });

  test("rows without a recorded URL are accepted on any destination", () => {
    const destination = { provider: "github" as const, url: "https://github.com" };
    expect(isRepositoryOnConfiguredDestination({}, destination)).toBe(true);
    expect(isRepositoryOnConfiguredDestination({ destinationProvider: "gitea", destinationUrl: "" }, destination)).toBe(true);
  });

  test("rows on a different host or a different transport are refused", () => {
    const github = { provider: "github" as const, url: "https://github.com" };
    expect(
      isRepositoryOnConfiguredDestination({ destinationProvider: "github", destinationUrl: "https://github.com/" }, github)
    ).toBe(true);
    expect(
      isRepositoryOnConfiguredDestination({ destinationProvider: "gitlab", destinationUrl: "https://gitlab.com" }, github)
    ).toBe(false);
    expect(
      isRepositoryOnConfiguredDestination(
        { destinationProvider: "gitea", destinationUrl: "https://gitea.example.com" },
        { provider: "forgejo", url: "https://gitea.example.com" }
      )
    ).toBe(true);
    expect(
      isRepositoryOnConfiguredDestination(
        { destinationProvider: "gitea", destinationUrl: "https://gitea.example.com" },
        { provider: "gitea", url: "https://other.example.com" }
      )
    ).toBe(false);
  });

  test("describes a stored destination", () => {
    expect(describeDestination(getRepositoryDestination({ destinationProvider: "gitlab", destinationUrl: "https://gitlab.com" }))).toBe(
      "GitLab (https://gitlab.com)"
    );
    expect(describeDestination(getRepositoryDestination({}))).toBe("Gitea (no URL)");
  });
});
