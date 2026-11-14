import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GitSourceProvider,
  parseRefAdvertisement,
  resolveGitRepositoryPath,
} from "./git-source";
import { createSourceProvider, SourceApiError } from "./index";
import {
  normalizeSourceUrl,
  sourceKindListsRepositories,
  sourceKindSupportsReleases,
} from "./kinds";

const SHA = "ffd269952ae2d30d47c8ecb89291ac5d912cfc1c";

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

/** What a smart HTTP server answers for info/refs?service=git-upload-pack. */
function smartAdvertisement(branch = "master"): string {
  return (
    pkt("# service=git-upload-pack\n") +
    "0000" +
    pkt(`${SHA} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/${branch} agent=git/2.40\n`) +
    pkt(`${SHA} refs/heads/${branch}\n`) +
    "0000"
  );
}

const SMART = "application/x-git-upload-pack-advertisement";
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

// Other test files replace the global fetch and the replacement can outlive
// them, so these tests talk to their server through the runtime's own.
const REAL_FETCH = { fetchImpl: Bun.fetch as unknown as typeof fetch };

let server: ReturnType<typeof Bun.serve>;
let base: string;
let hostname: string;
const seen: Array<{ path: string; authorization: string | null }> = [];
let endlessChunks = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      seen.push({ path: url.pathname + url.search, authorization });
      const refs = url.pathname.endsWith("/info/refs");
      const smart = (body: string) => new Response(body, { headers: { "content-type": SMART } });

      // Smart server that only knows the .git spelling.
      if (url.pathname === "/project/alice/tool.git/info/refs") return smart(smartAdvertisement());
      // Smart server that only knows the bare spelling, at the root of the host.
      if (url.pathname === "/rootrepo/info/refs") return smart(smartAdvertisement("trunk"));
      // Needs a login.
      if (url.pathname === "/team/secret.git/info/refs") {
        return authorization === basic("bob", "hunter2")
          ? smart(smartAdvertisement("main"))
          : new Response("", { status: 401 });
      }
      // Hides private repositories behind a 404 until a login is sent.
      if (url.pathname === "/team/hidden.git/info/refs") {
        return authorization ? smart(smartAdvertisement("main")) : new Response("", { status: 404 });
      }
      // Dumb HTTP: a plain file listing refs, and a HEAD file.
      if (url.pathname === "/dumb/old.git/info/refs") {
        return new Response(`${SHA}\trefs/heads/develop\n${SHA}\trefs/tags/v1\n`, {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url.pathname === "/dumb/old.git/HEAD") return new Response("ref: refs/heads/develop\n");
      // A web app that answers 200 with a page for any path.
      if (url.pathname.startsWith("/webapp/")) {
        return new Response("<html>hello</html>", { headers: { "content-type": "text/html" } });
      }
      // Sends refs forever, a small piece at a time.
      if (url.pathname === "/big/endless.git/info/refs") {
        const head = new TextEncoder().encode(smartAdvertisement("main").slice(0, -4));
        const line = new TextEncoder().encode(
          pkt(`${SHA} refs/heads/branch-with-a-long-name\n`).repeat(200)
        );
        let first = true;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(2);
              endlessChunks += 1;
              controller.enqueue(first ? head : line);
              first = false;
            },
          }),
          { headers: { "content-type": SMART } }
        );
      }
      if (url.pathname === "/broken/repo.git/info/refs" || url.pathname === "/broken/repo/info/refs") {
        return new Response("", { status: 500 });
      }
      if (url.pathname === "/moved/repo.git/info/refs") {
        return Response.redirect(`${base}/project/alice/tool.git/info/refs${url.search}`, 302);
      }
      return new Response(refs ? "" : "not here", { status: 404 });
    },
  });
  hostname = "127.0.0.1";
  base = `http://${hostname}:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function provider(credentials: { username?: string; token?: string } = {}) {
  return new GitSourceProvider(
    {
      provider: "git",
      url: base,
      username: credentials.username ?? "",
      token: credentials.token ?? "",
    },
    REAL_FETCH
  );
}

describe("parseRefAdvertisement", () => {
  test("reads the default branch from a smart advertisement", () => {
    expect(parseRefAdvertisement(smartAdvertisement("trunk"), SMART)).toEqual({ defaultBranch: "trunk" });
  });

  test("accepts a smart advertisement without a symref, such as an empty repository", () => {
    const body = pkt("# service=git-upload-pack\n") + "0000" + pkt(`${"0".repeat(40)} capabilities^{}\0agent=git/2\n`) + "0000";
    expect(parseRefAdvertisement(body, SMART)).toEqual({ defaultBranch: null });
  });

  test("accepts a dumb ref listing", () => {
    expect(parseRefAdvertisement(`${SHA}\trefs/heads/main\n`, "text/plain")).toEqual({ defaultBranch: null });
  });

  test("refuses anything else", () => {
    expect(parseRefAdvertisement("<html>hello</html>", "text/html")).toBeNull();
    expect(parseRefAdvertisement("", "text/plain")).toBeNull();
  });
});

describe("resolveGitRepositoryPath", () => {
  test("keeps the whole path in front of the repository as the owner", () => {
    expect(resolveGitRepositoryPath(["project", "alice", "tool.git"], "git.example.org")).toEqual({
      owner: "project/alice",
      repo: "tool",
    });
  });

  test("uses the host for a repository at the root", () => {
    expect(resolveGitRepositoryPath(["cgit"], "git.example.org")).toEqual({
      owner: "git.example.org",
      repo: "cgit",
    });
  });

  test("returns null without a repository name", () => {
    expect(resolveGitRepositoryPath([], "git.example.org")).toBeNull();
    expect(resolveGitRepositoryPath([".git"], "git.example.org")).toBeNull();
  });
});

describe("git source kind", () => {
  test("is built by the provider factory", () => {
    const built = createSourceProvider({ provider: "git", url: "https://git.example.org", username: "", token: "" });
    expect(built.kind).toBe("git");
  });

  test("has nothing to list and no releases", () => {
    expect(sourceKindListsRepositories("git")).toBe(false);
    expect(sourceKindListsRepositories("github")).toBe(true);
    expect(sourceKindListsRepositories(undefined)).toBe(true);
    expect(sourceKindSupportsReleases("git")).toBe(false);
  });

  test("keeps only the host of its URL and has no default", () => {
    expect(normalizeSourceUrl("https://Git.Example.org/project/alice/tool.git", "git")).toBe(
      "https://git.example.org"
    );
    expect(normalizeSourceUrl("git.example.org:8443/x", "git")).toBe("https://git.example.org:8443");
    expect(normalizeSourceUrl("", "git")).toBe("");
  });

  test("lists nothing", async () => {
    const git = provider();
    expect(await git.listRepositories({})).toEqual([]);
    expect(await git.listStarredRepositories({})).toEqual([]);
    expect(await git.listOrganizations({})).toEqual({ organizations: [], failedOrgs: [] });
    expect(await git.getOrganization("alice")).toBeNull();
    expect(await git.listOrganizationRepositories("alice")).toEqual([]);
    expect(await git.isRepositoryStarred("alice", "tool")).toBe(false);
  });
});

describe("GitSourceProvider.getRepository", () => {
  test("finds a public repository and records where it answered", async () => {
    const repo = await provider().getRepository("project/alice", "tool");
    expect(repo).not.toBeNull();
    expect(repo!.name).toBe("tool");
    expect(repo!.fullName).toBe("project/alice/tool");
    expect(repo!.owner).toBe("alice");
    expect(repo!.organization).toBeUndefined();
    expect(repo!.sourceProvider).toBe("git");
    expect(repo!.sourceUrl).toBe(base);
    expect(repo!.cloneUrl).toBe(`${base}/project/alice/tool.git`);
    expect(repo!.defaultBranch).toBe("master");
    expect(repo!.isPrivate).toBe(false);
    expect(repo!.visibility).toBe("public");
  });

  test("accepts the name with its .git suffix", async () => {
    const repo = await provider().getRepository("project/alice", "tool.git");
    expect(repo!.cloneUrl).toBe(`${base}/project/alice/tool.git`);
  });

  test("falls back to the spelling without .git, at the root of the host", async () => {
    const git = provider();
    expect(git.resolveRepositoryPath(["rootrepo"])).toEqual({ owner: hostname, repo: "rootrepo" });
    const repo = await git.getRepository(hostname, "rootrepo");
    expect(repo!.cloneUrl).toBe(`${base}/rootrepo`);
    expect(repo!.fullName).toBe(`${hostname}/rootrepo`);
    expect(repo!.owner).toBe(hostname);
    expect(repo!.defaultBranch).toBe("trunk");
  });

  test("sends the login only after the host asked for one, and marks the repository private", async () => {
    seen.length = 0;
    const repo = await provider({ username: "bob", token: "hunter2" }).getRepository("team", "secret");
    expect(repo!.isPrivate).toBe(true);
    expect(repo!.visibility).toBe("private");
    expect(repo!.defaultBranch).toBe("main");
    const requests = seen.filter((entry) => entry.path.startsWith("/team/secret.git/"));
    expect(requests[0].authorization).toBeNull();
    expect(requests.at(-1)!.authorization).toBe(basic("bob", "hunter2"));
  });

  test("uses git as the username when only a password was given", async () => {
    seen.length = 0;
    await provider({ token: "t0ken" }).getRepository("team", "hidden");
    expect(seen.at(-1)!.authorization).toBe(basic("git", "t0ken"));
  });

  test("finds a repository the host hides behind a 404 until a login is sent", async () => {
    expect(await provider().getRepository("team", "hidden")).toBeNull();
    const repo = await provider({ username: "bob", token: "x" }).getRepository("team", "hidden");
    expect(repo!.isPrivate).toBe(true);
  });

  test("says a login is needed, or that the saved one was refused", async () => {
    const missing = await provider().getRepository("team", "secret").catch((error) => error);
    expect(missing).toBeInstanceOf(SourceApiError);
    expect(missing.status).toBe(401);
    expect(missing.message).toContain("was not served without a login");

    const wrong = await provider({ username: "bob", token: "nope" })
      .getRepository("team", "secret")
      .catch((error) => error);
    expect(wrong).toBeInstanceOf(SourceApiError);
    expect(wrong.message).toContain("refused the username and password");
  });

  test("reads a dumb HTTP repository and its HEAD file", async () => {
    const repo = await provider().getRepository("dumb", "old");
    expect(repo!.cloneUrl).toBe(`${base}/dumb/old.git`);
    expect(repo!.defaultBranch).toBe("develop");
  });

  test("does not take a web page for a repository", async () => {
    expect(await provider().getRepository("webapp", "anything")).toBeNull();
  });

  test("returns null when nothing answers at either spelling", async () => {
    expect(await provider().getRepository("nobody", "nothing")).toBeNull();
  });

  test("refuses path tricks", async () => {
    seen.length = 0;
    expect(await provider().getRepository("project/..", "tool")).toBeNull();
    expect(seen.length).toBe(0);
  });

  test("throws on a server error instead of calling the repository missing", async () => {
    const error = await provider().getRepository("broken", "repo").catch((caught) => caught);
    expect(error).toBeInstanceOf(SourceApiError);
    expect(error.status).toBe(500);
  });

  test("follows a redirect", async () => {
    const repo = await provider().getRepository("moved", "repo");
    expect(repo!.cloneUrl).toBe(`${base}/moved/repo.git`);
    expect(repo!.defaultBranch).toBe("master");
  });

  test("stops reading a ref listing that never ends, and hangs up", async () => {
    const repo = await provider().getRepository("big", "endless");
    expect(repo!.defaultBranch).toBe("main");

    // The server stops being asked for more once the connection is closed.
    await Bun.sleep(100);
    const afterReturn = endlessChunks;
    await Bun.sleep(200);
    expect(endlessChunks - afterReturn).toBeLessThanOrEqual(2);
  });
});

describe("GitSourceProvider.testConnection", () => {
  test("passes when the host answers at all", async () => {
    expect((await provider().testConnection()).login).toBe(hostname);
    expect((await provider({ username: "bob" }).testConnection()).login).toBe("bob");
  });

  test("fails when nothing listens there", async () => {
    const dead = new GitSourceProvider(
      { provider: "git", url: "http://127.0.0.1:1", username: "", token: "" },
      REAL_FETCH
    );
    await expect(dead.testConnection()).rejects.toThrow();
  });
});
