import { describe, expect, test, mock } from "bun:test";
import { getGithubRepositories } from "@/lib/github";

function makeRepo() {
  return {
    name: "demo",
    full_name: "octo/demo",
    html_url: "https://github.com/octo/demo",
    clone_url: "https://github.com/octo/demo.git",
    owner: { login: "octo", type: "User" },
    private: false,
    fork: false,
    has_issues: true,
    archived: false,
    size: 1,
    language: "TypeScript",
    description: "",
    default_branch: "main",
    visibility: "public",
    disabled: false,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  };
}

function makeOctokit() {
  let captured: Record<string, unknown> | null = null;
  const paginate = mock(async (_method: unknown, options?: Record<string, unknown>) => {
    captured = options ?? null;
    return [makeRepo()];
  });
  return {
    octokit: {
      paginate,
      repos: { listForAuthenticatedUser: () => {} },
    } as any,
    getCaptured: () => captured,
  };
}

describe("getGithubRepositories - affiliation", () => {
  test("defaults to owner+collaborator+organization_member when field is unset (backward compat)", async () => {
    const { octokit, getCaptured } = makeOctokit();
    await getGithubRepositories({ octokit, config: { githubConfig: { owner: "octo" } as any } });
    expect(getCaptured()?.affiliation).toBe("owner,collaborator,organization_member");
  });

  test("uses owner+organization_member when includeCollaboratorRepos is false", async () => {
    const { octokit, getCaptured } = makeOctokit();
    await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeCollaboratorRepos: false } as any },
    });
    expect(getCaptured()?.affiliation).toBe("owner,organization_member");
  });

  test("uses owner+collaborator+organization_member when includeCollaboratorRepos is true", async () => {
    const { octokit, getCaptured } = makeOctokit();
    await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeCollaboratorRepos: true } as any },
    });
    expect(getCaptured()?.affiliation).toBe("owner,collaborator,organization_member");
  });

  test("override forces owner+collaborator+organization_member regardless of config (used by cleanup)", async () => {
    const { octokit, getCaptured } = makeOctokit();
    await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeCollaboratorRepos: false } as any },
      includeCollaboratorReposOverride: true,
    });
    expect(getCaptured()?.affiliation).toBe("owner,collaborator,organization_member");
  });

  test("always includes organization_member (regression guard for org-repo invisibility)", async () => {
    const cases: Array<{ includeCollab?: boolean; override?: boolean }> = [
      {},
      { includeCollab: true },
      { includeCollab: false },
      { override: true },
      { includeCollab: false, override: true },
    ];
    for (const c of cases) {
      const { octokit, getCaptured } = makeOctokit();
      await getGithubRepositories({
        octokit,
        config: {
          githubConfig: {
            owner: "octo",
            ...(c.includeCollab !== undefined && { includeCollaboratorRepos: c.includeCollab }),
          } as any,
        },
        ...(c.override !== undefined && { includeCollaboratorReposOverride: c.override }),
      });
      const aff = String(getCaptured()?.affiliation ?? "");
      expect(aff.split(",")).toContain("organization_member");
    }
  });
});
