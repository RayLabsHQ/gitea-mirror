import { describe, expect, test } from "bun:test";
import type { Repository } from "@/lib/db/schema";
import { sortRepositories } from "@/lib/repository-sorting";

function makeRepo(overrides: Partial<Repository>): Repository {
  return {
    id: "id",
    userId: "user-1",
    configId: "config-1",
    name: "repo",
    fullName: "owner/repo",
    normalizedFullName: "owner/repo",
    url: "https://github.com/owner/repo",
    cloneUrl: "https://github.com/owner/repo.git",
    owner: "owner",
    organization: null,
    mirroredLocation: "",
    isPrivate: false,
    isForked: false,
    forkedFrom: null,
    hasIssues: true,
    isStarred: false,
    isArchived: false,
    size: 1,
    hasLFS: false,
    hasSubmodules: false,
    language: null,
    description: null,
    defaultBranch: "main",
    visibility: "public",
    status: "imported",
    lastMirrored: null,
    errorMessage: null,
    destinationOrg: null,
    metadata: null,
    importedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("sortRepositories", () => {
  test("defaults to recently imported first", () => {
    const repos = [
      makeRepo({ id: "a", fullName: "owner/a", importedAt: new Date("2026-01-01T00:00:00.000Z") }),
      makeRepo({ id: "b", fullName: "owner/b", importedAt: new Date("2026-03-01T00:00:00.000Z") }),
      makeRepo({ id: "c", fullName: "owner/c", importedAt: new Date("2025-12-01T00:00:00.000Z") }),
    ];

    const sorted = sortRepositories(repos, undefined);
    expect(sorted.map((repo) => repo.id)).toEqual(["b", "a", "c"]);
  });

  test("supports name and updated sorting", () => {
    const repos = [
      makeRepo({ id: "a", fullName: "owner/zeta", updatedAt: new Date("2026-01-01T00:00:00.000Z") }),
      makeRepo({ id: "b", fullName: "owner/alpha", updatedAt: new Date("2026-03-01T00:00:00.000Z") }),
      makeRepo({ id: "c", fullName: "owner/middle", updatedAt: new Date("2025-12-01T00:00:00.000Z") }),
    ];

    const nameSorted = sortRepositories(repos, "name-asc");
    expect(nameSorted.map((repo) => repo.id)).toEqual(["b", "c", "a"]);

    const updatedSorted = sortRepositories(repos, "updated-desc");
    expect(updatedSorted.map((repo) => repo.id)).toEqual(["b", "a", "c"]);
  });
});
