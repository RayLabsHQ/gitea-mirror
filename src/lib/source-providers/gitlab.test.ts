import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  GitLabSourceProvider,
  mapGitLabProject,
  resolveGitLabRepositoryPath,
  type GitLabProject,
} from "./gitlab";
import { SourceApiError } from "./http";

type Call = { url: string; headers: Record<string, string> };

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function project(overrides: Partial<GitLabProject> = {}): GitLabProject {
  return {
    id: 1,
    name: "Widget",
    path: "widget",
    path_with_namespace: "me/widget",
    web_url: "https://gitlab.example.com/me/widget",
    http_url_to_repo: "https://gitlab.example.com/me/widget.git",
    namespace: { kind: "user", path: "me", full_path: "me" },
    visibility: "public",
    default_branch: "main",
    created_at: "2024-01-01T00:00:00Z",
    last_activity_at: "2024-06-01T00:00:00Z",
    ...overrides,
  };
}

const connection = {
  provider: "gitlab" as const,
  url: "https://gitlab.example.com",
  username: "me",
  token: "glpat-secret",
};

let originalFetch: typeof globalThis.fetch;
let calls: Call[];

function installFetch(route: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return route(String(input));
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mapGitLabProject", () => {
  test("flattens a subgroup project onto its top level group", () => {
    const repo = mapGitLabProject(
      project({
        path_with_namespace: "acme/tools/widget",
        namespace: { kind: "group", path: "tools", full_path: "acme/tools" },
        web_url: "https://gitlab.example.com/acme/tools/widget",
        http_url_to_repo: "https://gitlab.example.com/acme/tools/widget.git",
      }),
      connection
    );

    expect(repo.fullName).toBe("acme/tools/widget");
    expect(repo.name).toBe("widget");
    expect(repo.owner).toBe("acme");
    expect(repo.organization).toBe("acme");
    expect(repo.cloneUrl).toBe("https://gitlab.example.com/acme/tools/widget.git");
    expect(repo.sourceProvider).toBe("gitlab");
    expect(repo.sourceUrl).toBe("https://gitlab.example.com");
  });

  test("uses the URL safe path as the name and leaves personal projects without an organization", () => {
    const repo = mapGitLabProject(project({ name: "My Widget", path: "my-widget" }), connection);
    expect(repo.name).toBe("my-widget");
    expect(repo.owner).toBe("me");
    expect(repo.organization).toBeUndefined();
    expect(repo.isStarred).toBe(false);
    expect(repo.isDisabled).toBe(false);
  });

  test("internal projects are private as far as a backup is concerned", () => {
    const repo = mapGitLabProject(project({ visibility: "internal" }), connection);
    expect(repo.visibility).toBe("internal");
    expect(repo.isPrivate).toBe(true);
    expect(mapGitLabProject(project({ visibility: "public" }), connection).isPrivate).toBe(false);
  });

  test("maps forks, archived state, disabled issues and dates", () => {
    const repo = mapGitLabProject(
      project({
        forked_from_project: { path_with_namespace: "upstream/widget" },
        archived: true,
        issues_access_level: "disabled",
      }),
      connection
    );
    expect(repo.isForked).toBe(true);
    expect(repo.forkedFrom).toBe("upstream/widget");
    expect(repo.isArchived).toBe(true);
    expect(repo.hasIssues).toBe(false);
    expect(repo.createdAt.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(repo.updatedAt.toISOString()).toBe("2024-06-01T00:00:00.000Z");
  });
});

describe("resolveGitLabRepositoryPath", () => {
  test("keeps nested groups as the owner and cuts deep links at the dash", () => {
    expect(resolveGitLabRepositoryPath(["acme", "tools", "widget", "-", "tree", "main"])).toEqual({
      owner: "acme/tools",
      repo: "widget",
    });
    expect(resolveGitLabRepositoryPath(["acme", "widget.git"])).toEqual({
      owner: "acme",
      repo: "widget",
    });
    expect(resolveGitLabRepositoryPath(["acme"])).toBeNull();
  });
});

describe("GitLabSourceProvider", () => {
  test("lists membership projects with the token, follows x-next-page and applies the config filters", async () => {
    const page1 = [
      project({ id: 1 }),
      project({
        id: 2,
        path: "tool",
        path_with_namespace: "acme/tools/tool",
        namespace: { kind: "group", path: "tools", full_path: "acme/tools" },
      }),
    ];
    const page2 = [
      project({
        id: 3,
        path: "forked",
        path_with_namespace: "me/forked",
        forked_from_project: { path_with_namespace: "upstream/forked" },
      }),
    ];
    installFetch((url) => {
      // "per_page=100" also contains "page=1", so match the page parameter itself.
      if (url.endsWith("&page=1")) return json(page1, { headers: { "x-next-page": "2" } });
      if (url.endsWith("&page=2")) return json(page2);
      return json({ message: "unexpected" }, { status: 500 });
    });

    const provider = new GitLabSourceProvider(connection);
    const repos = await provider.listRepositories({ githubConfig: { skipForks: true } as any });

    expect(calls[0].url).toBe(
      "https://gitlab.example.com/api/v4/projects?membership=true&order_by=id&sort=asc&per_page=100&page=1"
    );
    expect(calls[0].headers["PRIVATE-TOKEN"]).toBe("glpat-secret");
    expect(calls).toHaveLength(2);
    expect(repos.map((r) => r.fullName)).toEqual(["me/widget", "acme/tools/tool"]);
    expect(repos[1].organization).toBe("acme");
  });

  test("without a token it lists the user's public projects and sends no token header", async () => {
    installFetch(() => json([project()]));

    const provider = new GitLabSourceProvider({ ...connection, token: "" });
    const repos = await provider.listRepositories({});

    expect(calls[0].url.startsWith("https://gitlab.example.com/api/v4/users/me/projects?")).toBe(true);
    expect(calls[0].headers["PRIVATE-TOKEN"]).toBeUndefined();
    expect(repos).toHaveLength(1);
  });

  test("starred projects are flagged as starred", async () => {
    installFetch(() => json([project()]));
    const repos = await new GitLabSourceProvider(connection).listStarredRepositories({});
    expect(calls[0].url).toContain("/api/v4/projects?starred=true");
    expect(repos[0].isStarred).toBe(true);
  });

  test("getRepository encodes the project path, returns null on 404 and throws otherwise", async () => {
    installFetch((url) => {
      if (url.endsWith("/api/v4/projects/acme%2Ftools%2Fwidget")) return json(project());
      if (url.endsWith("/api/v4/projects/acme%2Fmissing")) return json({ message: "404 Not Found" }, { status: 404 });
      return json({ message: "boom" }, { status: 500 });
    });
    const provider = new GitLabSourceProvider(connection);

    expect((await provider.getRepository("acme/tools", "widget"))?.fullName).toBe("me/widget");
    expect(await provider.getRepository("acme", "missing")).toBeNull();
    await expect(provider.getRepository("acme", "broken")).rejects.toBeInstanceOf(SourceApiError);
  });

  test("lists top level groups and counts their projects from x-total", async () => {
    installFetch((url) => {
      if (url.includes("/api/v4/groups?")) {
        return json([{ id: 7, full_path: "acme", avatar_url: null }, { id: 8, full_path: "ignored" }]);
      }
      if (url.includes("/api/v4/groups/7/projects?")) return json([{}], { headers: { "x-total": "12" } });
      return json({ message: "unexpected" }, { status: 500 });
    });
    const { organizations, failedOrgs } = await new GitLabSourceProvider(connection).listOrganizations(
      {},
      new Set(["ignored"])
    );

    expect(calls[0].url).toContain("top_level_only=true");
    expect(organizations).toHaveLength(1);
    expect(organizations[0].name).toBe("acme");
    expect(organizations[0].repositoryCount).toBe(12);
    expect(failedOrgs).toEqual([]);
  });

  test("isRepositoryStarred matches the full path among starred search results", async () => {
    installFetch(() =>
      json([project({ path_with_namespace: "other/widget" }), project({ path_with_namespace: "Acme/Widget" })])
    );
    const provider = new GitLabSourceProvider(connection);
    expect(await provider.isRepositoryStarred("acme", "widget")).toBe(true);
    expect(await provider.isRepositoryStarred("acme", "gadget")).toBe(false);
    expect(calls[0].url).toContain("starred=true");
    expect(calls[0].url).toContain("search=widget");
  });

  test("testConnection reads /user and requires a token", async () => {
    installFetch(() => json({ username: "me", name: "Me", avatar_url: "https://a/b.png" }));
    const account = await new GitLabSourceProvider(connection).testConnection();
    expect(calls[0].url).toBe("https://gitlab.example.com/api/v4/user");
    expect(account).toEqual({ login: "me", name: "Me", avatarUrl: "https://a/b.png" });

    await expect(new GitLabSourceProvider({ ...connection, token: "" }).testConnection()).rejects.toThrow(
      /token is required/
    );
  });
});
