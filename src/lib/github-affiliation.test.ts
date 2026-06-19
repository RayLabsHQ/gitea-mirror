import { describe, expect, test, mock } from "bun:test";
import { getGithubRepositories } from "@/lib/github";

function makeRepo(overrides: Partial<{
  name: string;
  full_name: string;
  ownerLogin: string;
  ownerType: string;
  fork: boolean;
}> = {}) {
  const ownerLogin = overrides.ownerLogin ?? "octo";
  const ownerType = overrides.ownerType ?? "User";
  return {
    name: overrides.name ?? "demo",
    full_name: overrides.full_name ?? `${ownerLogin}/${overrides.name ?? "demo"}`,
    html_url: `https://github.com/${ownerLogin}/${overrides.name ?? "demo"}`,
    clone_url: `https://github.com/${ownerLogin}/${overrides.name ?? "demo"}.git`,
    owner: { login: ownerLogin, type: ownerType },
    private: false,
    fork: overrides.fork ?? false,
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

function makeOctokit(reposToReturn?: ReturnType<typeof makeRepo>[]) {
  let captured: Record<string, unknown> | null = null;
  const paginate = mock(async (_method: unknown, options?: Record<string, unknown>) => {
    captured = options ?? null;
    return reposToReturn ?? [makeRepo()];
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

describe("getGithubRepositories - skipPersonalRepos", () => {
  const personalRepo = makeRepo({ name: "my-lib", ownerLogin: "octo", ownerType: "User" });
  const orgRepo = makeRepo({ name: "org-lib", ownerLogin: "my-org", ownerType: "Organization" });
  const otherUserRepo = makeRepo({ name: "collab-lib", ownerLogin: "other-user", ownerType: "User" });

  test("default false — keeps all repos including personal", async () => {
    const { octokit } = makeOctokit([personalRepo, orgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", skipPersonalRepos: false } as any },
    });
    expect(repos.map((r) => r.name)).toContain("my-lib");
    expect(repos.map((r) => r.name)).toContain("org-lib");
  });

  test("skipPersonalRepos=true — drops repos owned by authenticated user", async () => {
    const { octokit } = makeOctokit([personalRepo, orgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", skipPersonalRepos: true } as any },
    });
    expect(repos.map((r) => r.name)).not.toContain("my-lib");
    expect(repos.map((r) => r.name)).toContain("org-lib");
  });

  test("skipPersonalRepos=true — keeps repos owned by other users (collaborator repos)", async () => {
    const { octokit } = makeOctokit([personalRepo, orgRepo, otherUserRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", skipPersonalRepos: true } as any },
    });
    expect(repos.map((r) => r.name)).not.toContain("my-lib");
    expect(repos.map((r) => r.name)).toContain("org-lib");
    expect(repos.map((r) => r.name)).toContain("collab-lib");
  });

  test("skipPersonalRepos=true with no owner configured — keeps all repos (safe fallback)", async () => {
    const { octokit } = makeOctokit([personalRepo, orgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "", skipPersonalRepos: true } as any },
    });
    // Empty owner means we can't identify the user, so nothing should be dropped
    expect(repos.map((r) => r.name)).toContain("my-lib");
    expect(repos.map((r) => r.name)).toContain("org-lib");
  });

  test("skipPersonalRepos=true — unset (undefined) behaves like false", async () => {
    const { octokit } = makeOctokit([personalRepo, orgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo" } as any },
    });
    expect(repos.map((r) => r.name)).toContain("my-lib");
    expect(repos.map((r) => r.name)).toContain("org-lib");
  });
});

describe("getGithubRepositories - includeOrganizations allowlist", () => {
  const personalRepo = makeRepo({ name: "my-lib", ownerLogin: "octo", ownerType: "User" });
  const wantedOrgRepo = makeRepo({ name: "wanted", ownerLogin: "wanted-org", ownerType: "Organization" });
  const otherOrgRepo = makeRepo({ name: "noise", ownerLogin: "noise-org", ownerType: "Organization" });
  const collabRepo = makeRepo({ name: "collab", ownerLogin: "other-user", ownerType: "User" });

  test("empty allowlist — keeps repos from all orgs (backward compat)", async () => {
    const { octokit } = makeOctokit([wantedOrgRepo, otherOrgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeOrganizations: [] } as any },
    });
    expect(repos.map((r) => r.name)).toContain("wanted");
    expect(repos.map((r) => r.name)).toContain("noise");
  });

  test("non-empty allowlist — keeps only listed orgs, drops other orgs", async () => {
    const { octokit } = makeOctokit([wantedOrgRepo, otherOrgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeOrganizations: ["wanted-org"] } as any },
    });
    expect(repos.map((r) => r.name)).toContain("wanted");
    expect(repos.map((r) => r.name)).not.toContain("noise");
  });

  test("allowlist match is case-insensitive", async () => {
    const { octokit } = makeOctokit([wantedOrgRepo, otherOrgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeOrganizations: ["Wanted-Org"] } as any },
    });
    expect(repos.map((r) => r.name)).toContain("wanted");
    expect(repos.map((r) => r.name)).not.toContain("noise");
  });

  test("allowlist never restricts personal or collaborator repos", async () => {
    const { octokit } = makeOctokit([personalRepo, collabRepo, wantedOrgRepo, otherOrgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeOrganizations: ["wanted-org"] } as any },
    });
    // User-owned and collaborator repos pass through regardless of the allowlist
    expect(repos.map((r) => r.name)).toContain("my-lib");
    expect(repos.map((r) => r.name)).toContain("collab");
    expect(repos.map((r) => r.name)).toContain("wanted");
    expect(repos.map((r) => r.name)).not.toContain("noise");
  });

  test("composes with skipPersonalRepos — drops personal, keeps only listed org", async () => {
    const { octokit } = makeOctokit([personalRepo, wantedOrgRepo, otherOrgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: {
        githubConfig: {
          owner: "octo",
          skipPersonalRepos: true,
          includeOrganizations: ["wanted-org"],
        } as any,
      },
    });
    expect(repos.map((r) => r.name)).not.toContain("my-lib");
    expect(repos.map((r) => r.name)).toContain("wanted");
    expect(repos.map((r) => r.name)).not.toContain("noise");
  });

  test("blank/whitespace entries are ignored (treated as empty allowlist)", async () => {
    const { octokit } = makeOctokit([wantedOrgRepo, otherOrgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeOrganizations: ["  ", ""] } as any },
    });
    expect(repos.map((r) => r.name)).toContain("wanted");
    expect(repos.map((r) => r.name)).toContain("noise");
  });

  test("includeAllOrgsOverride bypasses allowlist (cleanup safety)", async () => {
    const { octokit } = makeOctokit([wantedOrgRepo, otherOrgRepo]);
    const repos = await getGithubRepositories({
      octokit,
      config: { githubConfig: { owner: "octo", includeOrganizations: ["wanted-org"] } as any },
      includeAllOrgsOverride: true,
    });
    // Override returns all org repos so cleanup never false-orphans excluded orgs
    expect(repos.map((r) => r.name)).toContain("wanted");
    expect(repos.map((r) => r.name)).toContain("noise");
  });
});
