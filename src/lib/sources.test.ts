import { beforeAll, describe, expect, test } from "bun:test";
import {
  decryptSourceToken,
  deriveSourceName,
  findSourceForRepository,
  primarySource,
  resolveGitHubApiBaseUrl,
  selectRepositoriesToRelink,
  type SourceRecord,
} from "./sources";
import { encrypt } from "./utils/encryption";

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "src-1",
    userId: "user-1",
    name: "GitHub (octocat)",
    provider: "github",
    url: "https://github.com",
    username: "octocat",
    token: null,
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("deriveSourceName", () => {
  test("appends the username when present", () => {
    expect(deriveSourceName("github", "octocat")).toBe("GitHub (octocat)");
    expect(deriveSourceName("gitea", "me")).toBe("Gitea / Forgejo (me)");
  });

  test("falls back to the provider label without a username", () => {
    expect(deriveSourceName("gitlab", "")).toBe("GitLab");
  });
});

describe("primarySource", () => {
  test("returns the first entry", () => {
    const list = [source({ id: "a" }), source({ id: "b" })];
    expect(primarySource(list)?.id).toBe("a");
  });

  test("returns null when nothing is connected", () => {
    expect(primarySource([])).toBeNull();
  });
});

describe("findSourceForRepository", () => {
  const github = source();
  const gitlab = source({
    id: "src-2",
    provider: "gitlab",
    url: "https://gitlab.com",
    username: "me",
  });

  test("matches by the stored source id first", () => {
    const repo = { sourceId: "src-2", sourceProvider: "github", sourceUrl: "https://github.com" };
    expect(findSourceForRepository(repo, [github, gitlab])?.id).toBe("src-2");
  });

  test("falls back to provider and normalized url when the id dangles", () => {
    const repo = {
      sourceId: "deleted-source",
      sourceProvider: "gitlab",
      sourceUrl: "https://gitlab.com",
    };
    expect(findSourceForRepository(repo, [github, gitlab])?.id).toBe("src-2");
  });

  test("matches by provider and url for legacy rows without a source id", () => {
    const repo = { sourceProvider: "gitea", sourceUrl: "https://codeberg.org" };
    const codeberg = source({
      id: "src-3",
      provider: "gitea",
      url: "https://codeberg.org",
      username: "me",
    });
    expect(findSourceForRepository(repo, [github, codeberg])?.id).toBe("src-3");
  });

  test("returns null for a host that is not connected", () => {
    const repo = { sourceProvider: "gitlab", sourceUrl: "https://gitlab.example.com" };
    expect(findSourceForRepository(repo, [github, gitlab])).toBeNull();
  });

  test("returns null when nothing is connected", () => {
    const repo = { sourceProvider: "github", sourceUrl: "https://github.com" };
    expect(findSourceForRepository(repo, [])).toBeNull();
  });
});

describe("selectRepositoriesToRelink", () => {
  const connected = new Set(["src-1"]);
  const base = {
    sourceProvider: "github" as const,
    sourceUrl: "https://github.com",
    normalizedFullName: "octocat/tool",
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };

  test("collects dangling and null-id rows for the same provider and host", () => {
    const rows = [
      { id: "r-1", sourceId: "deleted-source", ...base },
      { id: "r-2", sourceId: null, ...base, normalizedFullName: "octocat/second" },
      { id: "r-3", ...base, normalizedFullName: "octocat/third" },
    ];
    const result = selectRepositoriesToRelink(rows, connected, "github", "https://github.com");
    expect(result.relinkIds).toEqual(["r-1", "r-2", "r-3"]);
    expect(result.duplicateIds).toEqual([]);
  });

  test("keeps rows owned by a live source or another host", () => {
    const rows = [
      { id: "r-1", sourceId: "src-1", ...base },
      { id: "r-2", sourceId: "deleted-source", ...base, sourceProvider: "gitlab" as const, sourceUrl: "https://gitlab.com" },
      { id: "r-3", sourceId: "deleted-source", ...base, sourceUrl: "https://ghe.example.com" },
    ];
    const result = selectRepositoriesToRelink(rows, connected, "github", "https://github.com");
    expect(result.relinkIds).toEqual([]);
    expect(result.duplicateIds).toEqual([]);
  });

  test("same-name stale rows collapse to the newest one so the relink cannot violate the unique index", () => {
    const rows = [
      { id: "r-old", sourceId: "dead-incarnation-1", ...base, updatedAt: new Date("2026-01-01T00:00:00Z") },
      { id: "r-new", sourceId: "dead-incarnation-2", ...base, updatedAt: new Date("2026-02-01T00:00:00Z") },
      { id: "r-other", sourceId: null, ...base, normalizedFullName: "octocat/other" },
    ];
    const result = selectRepositoriesToRelink(rows, connected, "github", "https://github.com");
    expect(result.relinkIds).toEqual(["r-new", "r-other"]);
    expect(result.duplicateIds).toEqual(["r-old"]);
  });
});

describe("decryptSourceToken", () => {
  beforeAll(() => {
    // encrypt() needs a secret; do not depend on the environment or on test order.
    process.env.ENCRYPTION_SECRET ??= "sources-test-encryption-secret";
  });

  test("round-trips an encrypted token", () => {
    expect(decryptSourceToken(encrypt("ghp-secret"))).toBe("ghp-secret");
  });

  test("empty means public-only and never throws", () => {
    expect(decryptSourceToken(null)).toBe("");
    expect(decryptSourceToken(undefined)).toBe("");
    expect(decryptSourceToken("")).toBe("");
  });
});

describe("resolveGitHubApiBaseUrl", () => {
  test("github.com and empty keep the environment default", () => {
    expect(resolveGitHubApiBaseUrl("https://github.com")).toBeUndefined();
    expect(resolveGitHubApiBaseUrl("")).toBeUndefined();
    expect(resolveGitHubApiBaseUrl(null)).toBeUndefined();
    expect(resolveGitHubApiBaseUrl(undefined)).toBeUndefined();
  });

  test("a GitHub Enterprise instance is addressed at /api/v3", () => {
    expect(resolveGitHubApiBaseUrl("https://ghe.example.com")).toBe("https://ghe.example.com/api/v3");
    expect(resolveGitHubApiBaseUrl("https://ghe.example.com/")).toBe("https://ghe.example.com/api/v3");
  });
});
