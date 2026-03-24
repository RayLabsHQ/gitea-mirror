import { describe, expect, test, mock } from "bun:test";
import {
  getGithubStarredListNames,
  getGithubStarredRepositories,
} from "@/lib/github";

function makeRestStarredRepo(overrides: Record<string, unknown> = {}) {
  return {
    name: "demo",
    full_name: "acme/demo",
    html_url: "https://github.com/acme/demo",
    clone_url: "https://github.com/acme/demo.git",
    owner: {
      login: "acme",
      type: "Organization",
    },
    private: false,
    fork: false,
    has_issues: true,
    archived: false,
    size: 123,
    language: "TypeScript",
    description: "Demo",
    default_branch: "main",
    visibility: "public",
    disabled: false,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    ...overrides,
  };
}

function makeGraphqlListRepo(
  nameWithOwner: string,
  overrides: Record<string, unknown> = {},
) {
  const [owner, name] = nameWithOwner.split("/");
  return {
    __typename: "Repository" as const,
    name,
    nameWithOwner,
    url: `https://github.com/${nameWithOwner}`,
    sshUrl: `git@github.com:${nameWithOwner}.git`,
    isPrivate: false,
    isFork: false,
    isArchived: false,
    isDisabled: false,
    hasIssuesEnabled: true,
    diskUsage: 456,
    description: `${name} repo`,
    defaultBranchRef: { name: "main" },
    visibility: "PUBLIC" as const,
    updatedAt: "2024-01-02T00:00:00Z",
    createdAt: "2024-01-01T00:00:00Z",
    owner: {
      __typename: "Organization" as const,
      login: owner,
    },
    primaryLanguage: { name: "TypeScript" },
    ...overrides,
  };
}

describe("GitHub starred lists support", () => {
  test("falls back to REST starred endpoint when no lists are configured", async () => {
    const paginate = mock(async () => [makeRestStarredRepo()]);
    const graphql = mock(async () => {
      throw new Error("GraphQL should not be used in REST fallback path");
    });

    const octokit = {
      paginate,
      graphql,
      activity: {
        listReposStarredByAuthenticatedUser: () => {},
      },
    } as any;

    const repos = await getGithubStarredRepositories({
      octokit,
      config: { githubConfig: { starredLists: [] } } as any,
    });

    expect(repos).toHaveLength(1);
    expect(repos[0].fullName).toBe("acme/demo");
    expect(repos[0].isStarred).toBe(true);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledTimes(0);
  });

  test("filters starred repositories by configured list names and de-duplicates", async () => {
    const paginate = mock(async () => []);
    const graphql = mock(async (_query: string, variables?: Record<string, unknown>) => {
      if (!variables || !("listId" in variables)) {
        return {
          viewer: {
            lists: {
              nodes: [
                null,
                { id: "list-1", name: "HomeLab" },
                { id: "list-2", name: "DotTools" },
                { id: "list-3", name: "Ideas" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }

      if (variables.listId === "list-1") {
        return {
          node: {
            items: {
              nodes: [
                null,
                makeGraphqlListRepo("acme/repo-a"),
                makeGraphqlListRepo("acme/repo-b"),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }

      return {
        node: {
          items: {
            nodes: [
              makeGraphqlListRepo("acme/repo-b"),
              makeGraphqlListRepo("acme/repo-c"),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    const octokit = {
      paginate,
      graphql,
      activity: {
        listReposStarredByAuthenticatedUser: () => {},
      },
    } as any;

    const repos = await getGithubStarredRepositories({
      octokit,
      config: {
        githubConfig: {
          starredLists: ["homelab", "dottools"],
        },
      } as any,
    });

    expect(repos).toHaveLength(3);
    expect(repos.map((repo) => repo.fullName).sort()).toEqual([
      "acme/repo-a",
      "acme/repo-b",
      "acme/repo-c",
    ]);
    expect(paginate).toHaveBeenCalledTimes(0);
  });

  test("matches configured list names even when separators differ", async () => {
    const paginate = mock(async () => []);
    const graphql = mock(async (_query: string, variables?: Record<string, unknown>) => {
      if (!variables || !("listId" in variables)) {
        return {
          viewer: {
            lists: {
              nodes: [
                { id: "list-1", name: "UI Frontend" },
                { id: "list-2", name: "Email | Self - Hosted" },
                { id: "list-3", name: "PaaS | Hosting | Deploy" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }

      if (variables.listId === "list-1") {
        return {
          node: {
            items: {
              nodes: [makeGraphqlListRepo("acme/ui-app")],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }

      if (variables.listId === "list-2") {
        return {
          node: {
            items: {
              nodes: [makeGraphqlListRepo("acme/email-app")],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }

      return {
        node: {
          items: {
            nodes: [makeGraphqlListRepo("acme/paas-app")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    const octokit = {
      paginate,
      graphql,
      activity: {
        listReposStarredByAuthenticatedUser: () => {},
      },
    } as any;

    const repos = await getGithubStarredRepositories({
      octokit,
      config: {
        githubConfig: {
          starredLists: ["ui-frontend", "email-self-hosted", "paas-hosting-deploy"],
        },
      } as any,
    });

    expect(repos).toHaveLength(3);
    expect(repos.map((repo) => repo.fullName).sort()).toEqual([
      "acme/email-app",
      "acme/paas-app",
      "acme/ui-app",
    ]);
    expect(paginate).toHaveBeenCalledTimes(0);
  });

  test("throws when configured star list names do not match any GitHub list", async () => {
    const paginate = mock(async () => []);
    const graphql = mock(async (_query: string, variables?: Record<string, unknown>) => {
      if (!variables || !("listId" in variables)) {
        return {
          viewer: {
            lists: {
              nodes: [{ id: "list-1", name: "HomeLab" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }

      return {
        node: {
          items: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    const octokit = {
      paginate,
      graphql,
      activity: {
        listReposStarredByAuthenticatedUser: () => {},
      },
    } as any;

    await expect(
      getGithubStarredRepositories({
        octokit,
        config: {
          githubConfig: {
            starredLists: ["MissingList"],
          },
        } as any,
      }),
    ).rejects.toThrow("Configured GitHub star lists not found");
    expect(paginate).toHaveBeenCalledTimes(0);
  });

  test("returns all available starred list names with pagination", async () => {
    const graphql = mock(async (_query: string, variables?: Record<string, unknown>) => {
      if (!variables?.after) {
        return {
          viewer: {
            lists: {
              nodes: [
                null,
                { id: "a", name: "HomeLab" },
                { id: "b", name: "DotTools" },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        };
      }

      return {
        viewer: {
          lists: {
            nodes: [
              { id: "c", name: "Ideas" },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    const octokit = { graphql } as any;
    const lists = await getGithubStarredListNames({ octokit });
    expect(lists).toEqual(["HomeLab", "DotTools", "Ideas"]);
    expect(graphql).toHaveBeenCalledTimes(2);
  });
});
