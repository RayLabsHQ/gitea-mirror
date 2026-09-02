import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  GiteaSourceProvider,
  mapGiteaRepository,
  resolveFlatRepositoryPath,
  type GiteaRepository,
} from "./gitea-source";

type Call = { url: string; headers: Record<string, string> };

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function repo(overrides: Partial<GiteaRepository> & { name: string; owner: string }): GiteaRepository {
  const { owner, ...rest } = overrides;
  return {
    id: 1,
    full_name: `${owner}/${overrides.name}`,
    html_url: `https://codeberg.org/${owner}/${overrides.name}`,
    clone_url: `https://codeberg.org/${owner}/${overrides.name}.git`,
    owner: { login: owner, username: owner },
    private: false,
    fork: false,
    has_issues: true,
    archived: false,
    size: 42,
    default_branch: "main",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
    ...rest,
  };
}

const connection = {
  provider: "gitea" as const,
  url: "https://codeberg.org",
  username: "me",
  token: "cb-secret",
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

describe("mapGiteaRepository", () => {
  test("maps the repository payload and stamps the source", () => {
    const mapped = mapGiteaRepository(
      repo({ name: "tool", owner: "acme", fork: true, parent: { full_name: "upstream/tool" }, language: "Go" }),
      connection,
      { isOrganization: true }
    );
    expect(mapped.fullName).toBe("acme/tool");
    expect(mapped.owner).toBe("acme");
    expect(mapped.organization).toBe("acme");
    expect(mapped.isForked).toBe(true);
    expect(mapped.forkedFrom).toBe("upstream/tool");
    expect(mapped.language).toBe("Go");
    expect(mapped.size).toBe(42);
    expect(mapped.sourceProvider).toBe("gitea");
    expect(mapped.sourceUrl).toBe("https://codeberg.org");
  });

  test("private and internal repositories are both private for the mirror", () => {
    expect(mapGiteaRepository(repo({ name: "a", owner: "me", private: true }), connection).visibility).toBe("private");
    const internal = mapGiteaRepository(repo({ name: "b", owner: "me", internal: true }), connection);
    expect(internal.visibility).toBe("internal");
    expect(internal.isPrivate).toBe(true);
    expect(mapGiteaRepository(repo({ name: "c", owner: "me" }), connection).isPrivate).toBe(false);
  });
});

describe("resolveFlatRepositoryPath", () => {
  test("takes the first two segments and drops .git", () => {
    expect(resolveFlatRepositoryPath(["forgejo", "forgejo.git", "src", "branch", "main"])).toEqual({
      owner: "forgejo",
      repo: "forgejo",
    });
    expect(resolveFlatRepositoryPath(["only"])).toBeNull();
  });
});

describe("GiteaSourceProvider", () => {
  test("lists the account's repositories, telling org owners apart with one lookup per owner", async () => {
    installFetch((url) => {
      if (url.includes("/api/v1/user/orgs?")) return json([{ username: "acme" }], { headers: { "x-total-count": "1" } });
      if (url.includes("/api/v1/user/repos?")) {
        return json(
          [
            repo({ name: "mine", owner: "me" }),
            repo({ name: "tool", owner: "acme" }),
            repo({ name: "shared", owner: "bob" }),
            repo({ name: "shared2", owner: "bob" }),
          ],
          { headers: { "x-total-count": "4" } }
        );
      }
      if (url.endsWith("/api/v1/orgs/bob")) return json({ message: "not found" }, { status: 404 });
      return json({ message: "unexpected" }, { status: 500 });
    });

    const repos = await new GiteaSourceProvider(connection).listRepositories({});

    expect(calls[0].headers.Authorization).toBe("token cb-secret");
    expect(calls[1].url).toBe("https://codeberg.org/api/v1/user/repos?limit=50&page=1");
    expect(repos.map((r) => [r.fullName, r.organization ?? null])).toEqual([
      ["me/mine", null],
      ["acme/tool", "acme"],
      ["bob/shared", null],
      ["bob/shared2", null],
    ]);
    expect(calls.filter((c) => c.url.endsWith("/api/v1/orgs/bob"))).toHaveLength(1);
  });

  test("pages through starred repositories until x-total-count is reached", async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => repo({ name: `r${start + i}`, owner: "me" }));
    installFetch((url) => {
      if (url.includes("/api/v1/user/starred?limit=50&page=1")) return json(page(0, 50), { headers: { "x-total-count": "60" } });
      if (url.includes("/api/v1/user/starred?limit=50&page=2")) return json(page(50, 10), { headers: { "x-total-count": "60" } });
      return json({ message: "unexpected" }, { status: 500 });
    });

    const repos = await new GiteaSourceProvider(connection).listStarredRepositories({});
    expect(repos).toHaveLength(60);
    expect(repos.every((r) => r.isStarred)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("without a token it lists the user's public repositories", async () => {
    installFetch((url) => {
      if (url.includes("/api/v1/users/me/orgs?")) return json([]);
      if (url.includes("/api/v1/users/me/repos?")) return json([repo({ name: "pub", owner: "me" })]);
      return json({ message: "unexpected" }, { status: 500 });
    });
    const repos = await new GiteaSourceProvider({ ...connection, token: "" }).listRepositories({});
    expect(repos.map((r) => r.fullName)).toEqual(["me/pub"]);
    expect(calls.every((c) => c.headers.Authorization === undefined)).toBe(true);
  });

  test("getRepository returns null on 404 and marks org owned repositories", async () => {
    installFetch((url) => {
      if (url.endsWith("/api/v1/repos/acme/tool")) return json(repo({ name: "tool", owner: "acme" }));
      if (url.endsWith("/api/v1/orgs/acme")) return json({ username: "acme" });
      if (url.endsWith("/api/v1/repos/acme/missing")) return json({ message: "not found" }, { status: 404 });
      return json({ message: "unexpected" }, { status: 500 });
    });
    const provider = new GiteaSourceProvider(connection);
    const found = await provider.getRepository("acme", "tool");
    expect(found?.organization).toBe("acme");
    expect(await provider.getRepository("acme", "missing")).toBeNull();
  });

  test("isRepositoryStarred maps 204 to true and 404 to false", async () => {
    installFetch((url) => {
      if (url.endsWith("/api/v1/user/starred/acme/tool")) return new Response(null, { status: 204 });
      return json({ message: "not found" }, { status: 404 });
    });
    const provider = new GiteaSourceProvider(connection);
    expect(await provider.isRepositoryStarred("acme", "tool")).toBe(true);
    expect(await provider.isRepositoryStarred("acme", "other")).toBe(false);
  });

  test("lists organizations with their repository counts", async () => {
    installFetch((url) => {
      if (url.includes("/api/v1/user/orgs?")) return json([{ username: "acme", avatar_url: "https://a/acme.png" }]);
      if (url.includes("/api/v1/orgs/acme/repos?limit=1")) return json([{}], { headers: { "x-total-count": "7" } });
      return json({ message: "unexpected" }, { status: 500 });
    });
    const { organizations } = await new GiteaSourceProvider(connection).listOrganizations({});
    expect(organizations).toEqual([
      expect.objectContaining({ name: "acme", avatarUrl: "https://a/acme.png", repositoryCount: 7 }),
    ]);
  });

  test("testConnection reads /user", async () => {
    installFetch(() => json({ login: "me", full_name: "Me", avatar_url: "https://a/me.png" }));
    const account = await new GiteaSourceProvider(connection).testConnection();
    expect(calls[0].url).toBe("https://codeberg.org/api/v1/user");
    expect(account).toEqual({ login: "me", name: "Me", avatarUrl: "https://a/me.png" });
  });
});
