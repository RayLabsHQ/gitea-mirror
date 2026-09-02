import { describe, expect, test } from "bun:test";
import type { GitRepo } from "@/types/Repository";
import { filterSourceRepositories } from "./filters";

function repo(overrides: Partial<GitRepo> & { owner: string; name: string }): GitRepo {
  return {
    fullName: `${overrides.owner}/${overrides.name}`,
    url: `https://example.com/${overrides.owner}/${overrides.name}`,
    cloneUrl: `https://example.com/${overrides.owner}/${overrides.name}.git`,
    isPrivate: false,
    isForked: false,
    hasIssues: true,
    isStarred: false,
    isArchived: false,
    size: 0,
    hasLFS: false,
    hasSubmodules: false,
    defaultBranch: "main",
    visibility: "public",
    status: "imported",
    importedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const own = repo({ owner: "me", name: "mine" });
const collaborator = repo({ owner: "friend", name: "shared" });
const acme = repo({ owner: "acme", name: "tool", organization: "acme" });
const globex = repo({ owner: "globex", name: "app", organization: "globex" });
const fork = repo({ owner: "me", name: "forked", isForked: true });
const all = [own, collaborator, acme, globex, fork];

describe("filterSourceRepositories", () => {
  test("keeps everything with the default config", () => {
    const kept = filterSourceRepositories(all, { config: {}, username: "me" });
    expect(kept).toHaveLength(5);
  });

  test("skipForks drops forks", () => {
    const kept = filterSourceRepositories(all, {
      config: { githubConfig: { skipForks: true } as any },
      username: "me",
    });
    expect(kept.map((r) => r.name)).not.toContain("forked");
    expect(kept).toHaveLength(4);
  });

  test("skipPersonalRepos drops the configured account's own repos, not org repos", () => {
    const kept = filterSourceRepositories(all, {
      config: { githubConfig: { skipPersonalRepos: true } as any },
      username: "ME",
    });
    expect(kept.map((r) => r.name).sort()).toEqual(["app", "shared", "tool"]);
  });

  test("includeCollaboratorRepos=false drops other users' personal repos only", () => {
    const kept = filterSourceRepositories(all, {
      config: { githubConfig: { includeCollaboratorRepos: false } as any },
      username: "me",
    });
    expect(kept.map((r) => r.name)).not.toContain("shared");
    expect(kept.map((r) => r.name)).toContain("tool");
    expect(kept.map((r) => r.name)).toContain("mine");
  });

  test("the collaborator override wins over the config", () => {
    const kept = filterSourceRepositories(all, {
      config: { githubConfig: { includeCollaboratorRepos: false } as any },
      options: { includeCollaboratorReposOverride: true },
      username: "me",
    });
    expect(kept.map((r) => r.name)).toContain("shared");
  });

  test("an organization allowlist keeps only listed org repos and leaves personal repos alone", () => {
    const kept = filterSourceRepositories(all, {
      config: { githubConfig: { includeOrganizations: [" Acme "] } as any },
      username: "me",
    });
    expect(kept.map((r) => r.name).sort()).toEqual(["forked", "mine", "shared", "tool"]);
  });

  test("includeAllOrgsOverride ignores the allowlist", () => {
    const kept = filterSourceRepositories(all, {
      config: { githubConfig: { includeOrganizations: ["acme"] } as any },
      options: { includeAllOrgsOverride: true },
      username: "me",
    });
    expect(kept).toHaveLength(5);
  });
});
