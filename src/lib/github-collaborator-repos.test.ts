import { describe, expect, test, mock } from "bun:test";
import { getGithubRepositories } from "@/lib/github";

/**
 * Helper to create a mock GitHub repository object matching the shape
 * returned by octokit.repos.listForAuthenticatedUser.
 * Provides sensible defaults that can be overridden per test.
 */
function makeMockGitHubRepo(overrides: Record<string, unknown> = {}) {
  return {
    name: "my-repo",
    full_name: "testuser/my-repo",
    html_url: "https://github.com/testuser/my-repo",
    clone_url: "https://github.com/testuser/my-repo.git",
    owner: {
      login: "testuser",
      type: "User",
    },
    private: false,
    fork: false,
    has_issues: true,
    archived: false,
    size: 100,
    language: "TypeScript",
    description: "A test repo",
    default_branch: "main",
    visibility: "public",
    disabled: false,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Helper to create a minimal mock Octokit instance.
 * The `paginate` mock captures the options passed to listForAuthenticatedUser,
 * so tests can assert which `affiliation` value was used.
 */
function createMockOctokit(repos: ReturnType<typeof makeMockGitHubRepo>[] = []) {
  // Store the options that paginate was called with so we can inspect them later
  let capturedOptions: Record<string, unknown> | null = null;

  const paginate = mock(async (_method: unknown, options?: Record<string, unknown>) => {
    // Capture the options object (contains per_page, affiliation, etc.)
    capturedOptions = options ?? null;
    return repos;
  });

  return {
    octokit: {
      paginate,
      repos: {
        // This function reference is passed as the first arg to paginate;
        // it doesn't need to do anything since paginate is fully mocked.
        listForAuthenticatedUser: () => {},
      },
    } as any,
    paginate,
    /** Returns the options object that was passed to the most recent paginate call */
    getCapturedOptions: () => capturedOptions,
  };
}

describe("getGithubRepositories - includeCollaboratorRepos", () => {
  /**
   * When includeCollaboratorRepos is undefined (default),
   * only owner repos should be fetched (affiliation="owner").
   */
  test("defaults to affiliation 'owner' when includeCollaboratorRepos is not set", async () => {
    const ownedRepo = makeMockGitHubRepo({ name: "owned-repo", full_name: "testuser/owned-repo" });
    const { octokit, paginate, getCapturedOptions } = createMockOctokit([ownedRepo]);

    const repos = await getGithubRepositories({
      octokit,
      config: {
        githubConfig: {
          // includeCollaboratorRepos is intentionally omitted (undefined)
          username: "testuser",
          token: "test-token",
          privateRepositories: false,
          mirrorStarred: false,
        },
      } as any,
    });

    
    expect(paginate).toHaveBeenCalledTimes(1);

    // The affiliation passed to the API should be "owner" only
    const options = getCapturedOptions();
    expect(options).toBeTruthy();
    expect(options!.affiliation).toBe("owner");

    // Should return the single owned repo
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("owned-repo");
  });

  /**
   * When includeCollaboratorRepos is explicitly false,
   * only owner repos should be fetched (affiliation="owner").
   */
  test("uses affiliation 'owner' when includeCollaboratorRepos is false", async () => {
    const ownedRepo = makeMockGitHubRepo({ name: "owned-repo", full_name: "testuser/owned-repo" });
    const { octokit, paginate, getCapturedOptions } = createMockOctokit([ownedRepo]);

    const repos = await getGithubRepositories({
      octokit,
      config: {
        githubConfig: {
          // Explicitly disabled
          includeCollaboratorRepos: false,
          username: "testuser",
          token: "test-token",
          privateRepositories: false,
          mirrorStarred: false,
        },
      } as any,
    });

    
    expect(paginate).toHaveBeenCalledTimes(1);

    // The affiliation passed to the API should be "owner" only
    const options = getCapturedOptions();
    expect(options).toBeTruthy();
    expect(options!.affiliation).toBe("owner");

    // Should return the single owned repo
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("owned-repo");
  });

  /**
   * When includeCollaboratorRepos is true,
   * both owned and collaborator repos should be fetched (affiliation="owner,collaborator").
   */
  test("uses affiliation 'owner,collaborator' when includeCollaboratorRepos is true", async () => {
    const ownedRepo = makeMockGitHubRepo({ name: "owned-repo", full_name: "testuser/owned-repo" });
    const collabRepo = makeMockGitHubRepo({
      name: "collab-repo",
      full_name: "otheruser/collab-repo",
      owner: { login: "otheruser", type: "User" },
    });
    const { octokit, paginate, getCapturedOptions } = createMockOctokit([ownedRepo, collabRepo]);

    const repos = await getGithubRepositories({
      octokit,
      config: {
        githubConfig: {
          // Explicitly enabled
          includeCollaboratorRepos: true,
          username: "testuser",
          token: "test-token",
          privateRepositories: false,
          mirrorStarred: false,
        },
      } as any,
    });

    
    expect(paginate).toHaveBeenCalledTimes(1);

    // The affiliation passed to the API should include both owner and collaborator
    const options = getCapturedOptions();
    expect(options).toBeTruthy();
    expect(options!.affiliation).toBe("owner,collaborator");

    // Should return both repos (owned + collaborator)
    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name).sort()).toEqual(["collab-repo", "owned-repo"]);
  });

  /**
   * Collaborator repos should correctly populate owner field from the repo owner,
   * not from the authenticated user's username.
   */
  test("collaborator repos retain their original owner", async () => {
    const collabRepo = makeMockGitHubRepo({
      name: "their-repo",
      full_name: "otheruser/their-repo",
      owner: { login: "otheruser", type: "User" },
    });
    const { octokit } = createMockOctokit([collabRepo]);

    const repos = await getGithubRepositories({
      octokit,
      config: {
        githubConfig: {
          includeCollaboratorRepos: true,
          username: "testuser",
          token: "test-token",
          privateRepositories: false,
          mirrorStarred: false,
        },
      } as any,
    });

    // The repo owner should be the actual owner, not the authenticated user
    expect(repos).toHaveLength(1);
    expect(repos[0].owner).toBe("otheruser");
    expect(repos[0].fullName).toBe("otheruser/their-repo");
  });

  /**
   * When includeCollaboratorRepos is true and skipForks is also true,
   * forked collaborator repos should be filtered out.
   */
  test("skipForks still filters forked repos even with includeCollaboratorRepos enabled", async () => {
    const ownedRepo = makeMockGitHubRepo({ name: "owned-repo", full_name: "testuser/owned-repo" });
    const forkedCollabRepo = makeMockGitHubRepo({
      name: "forked-collab",
      full_name: "otheruser/forked-collab",
      owner: { login: "otheruser", type: "User" },
      fork: true,
    });
    const nonForkedCollabRepo = makeMockGitHubRepo({
      name: "non-forked-collab",
      full_name: "otheruser/non-forked-collab",
      owner: { login: "otheruser", type: "User" },
      fork: false,
    });
    const { octokit } = createMockOctokit([ownedRepo, forkedCollabRepo, nonForkedCollabRepo]);

    const repos = await getGithubRepositories({
      octokit,
      config: {
        githubConfig: {
          includeCollaboratorRepos: true,
          skipForks: true,
          username: "testuser",
          token: "test-token",
          privateRepositories: false,
          mirrorStarred: false,
        },
      } as any,
    });

    // The forked collaborator repo should be excluded
    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name).sort()).toEqual(["non-forked-collab", "owned-repo"]);
  });

  /**
   * Organization-owned repos that show up as collaborator repos
   * should correctly set the organization field.
   */
  test("organization-owned collaborator repos set the organization field", async () => {
    const orgCollabRepo = makeMockGitHubRepo({
      name: "org-repo",
      full_name: "some-org/org-repo",
      owner: { login: "some-org", type: "Organization" },
    });
    const { octokit } = createMockOctokit([orgCollabRepo]);

    const repos = await getGithubRepositories({
      octokit,
      config: {
        githubConfig: {
          includeCollaboratorRepos: true,
          username: "testuser",
          token: "test-token",
          privateRepositories: false,
          mirrorStarred: false,
        },
      } as any,
    });

    // Should correctly identify the organization field
    expect(repos).toHaveLength(1);
    expect(repos[0].owner).toBe("some-org");
    expect(repos[0].organization).toBe("some-org");
  });

  /**
   * When githubConfig is entirely missing from the config,
   * default to affiliation 'owner' (graceful fallback).
   */
  test("defaults to affiliation 'owner' when githubConfig is undefined", async () => {
    const repo = makeMockGitHubRepo();
    const { octokit, getCapturedOptions } = createMockOctokit([repo]);

    const repos = await getGithubRepositories({
      octokit,
      // No githubConfig at all
      config: {} as any,
    });

    // Should still work and default to owner-only affiliation
    const options = getCapturedOptions();
    expect(options!.affiliation).toBe("owner");
    expect(repos).toHaveLength(1);
  });
});
