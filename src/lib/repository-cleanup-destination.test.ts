/**
 * Cleanup only archives or deletes a destination repository it has confirmed
 * is the orphan's mirror, at the address the repository has now.
 *
 * Before, a row without a recorded location was acted on at the address the
 * strategy would use, whatever sat there: a regular repository, or another
 * source's mirror of the same name. And Gitea answers the old address of a
 * renamed or transferred repository with a 301, which fetch follows with the
 * same DELETE, so a stale address deleted whatever the repository became.
 *
 * The fake destination below answers like Gitea 1.24.7 does (checked against
 * a real server): 301 from an old address for GET and DELETE alike.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { runsIsolated } from "@/tests/isolated";

// Other files mock the Gitea and HTTP modules for the whole run; this one needs
// the real ones talking to the fake server.
const isChild = runsIsolated(import.meta.path);

const { deleteGiteaRepo } = isChild ? await import("./gitea") : ({} as any);
const { handleOrphanedRepository, locateOrphanMirror } = isChild
  ? await import("./repository-cleanup-service")
  : ({} as any);
const { buildRepositoryCleanupNotificationEvent } = isChild
  ? await import("./notification-service")
  : ({} as any);

type FakeRepo = { owner: string; name: string; mirror: boolean; original_url?: string };

const repos = new Map<string, FakeRepo>();
const redirects = new Map<string, string>();
const requests: Array<{ method: string; path: string }> = [];
const key = (owner: string, name: string) => `${owner}/${name}`.toLowerCase();

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname });
    const match = url.pathname.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)$/);
    if (!match) return new Response("not found", { status: 404 });
    const [owner, name] = [decodeURIComponent(match[1]), decodeURIComponent(match[2])];
    const repo = repos.get(key(owner, name));
    if (!repo) {
      const to = redirects.get(key(owner, name));
      if (to) return new Response(null, { status: 301, headers: { Location: `/api/v1/repos/${to}` } });
      return Response.json({ message: "not found" }, { status: 404 });
    }
    if (request.method === "GET") {
      return Response.json({
        id: 1,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        mirror: repo.mirror,
        original_url: repo.original_url ?? "",
      });
    }
    if (request.method === "DELETE") {
      repos.delete(key(owner, name));
      return new Response(null, { status: 204 });
    }
    if (request.method === "PATCH") {
      const body = (await request.json()) as { name?: string };
      if (body.name && body.name !== repo.name) {
        repos.delete(key(owner, name));
        redirects.set(key(owner, name), `${repo.owner}/${body.name}`);
        repo.name = body.name;
        repos.set(key(repo.owner, repo.name), repo);
      }
      return Response.json({ name: repo.name, full_name: `${repo.owner}/${repo.name}` });
    }
    return new Response("method not allowed", { status: 405 });
  },
});
afterAll(() => server.stop(true));

const GITEA = `http://127.0.0.1:${server.port}`;
const SOURCE = "https://github.com/acme/tool.git";

const config = (deleteFromGitea = true) =>
  ({
    userId: "user-1",
    giteaConfig: { url: GITEA, token: "plain-token", defaultOwner: "me" },
    githubConfig: { owner: "me", mirrorStrategy: "flat-user" },
    cleanupConfig: { deleteFromGitea },
  }) as any;

const row = (mirroredLocation = "") =>
  ({
    id: "repo-1",
    userId: "user-1",
    name: "tool",
    fullName: "acme/tool",
    owner: "acme",
    organization: null,
    cloneUrl: SOURCE,
    mirroredLocation,
    status: "mirrored",
    isStarred: false,
    isArchived: false,
  }) as any;

const put = (repo: FakeRepo) => repos.set(key(repo.owner, repo.name), { ...repo });
const has = (owner: string, name: string) => repos.has(key(owner, name));
const sent = (method: string) => requests.filter((request) => request.method === method).map((request) => request.path);

beforeEach(() => {
  repos.clear();
  redirects.clear();
  requests.length = 0;
});

describe.skipIf(!isChild)("deleteGiteaRepo", () => {
  test("refuses an old address instead of deleting what the repository became", async () => {
    put({ owner: "me", name: "new-name", mirror: true, original_url: SOURCE });
    redirects.set(key("me", "old-name"), "me/new-name");

    await expect(deleteGiteaRepo({ url: GITEA, token: "t" }, "me", "old-name")).rejects.toThrow("301");

    expect(has("me", "new-name")).toBe(true);
    expect(sent("DELETE")).toEqual(["/api/v1/repos/me/old-name"]);
  });

  test("deletes at the current address", async () => {
    put({ owner: "me", name: "tool", mirror: true, original_url: SOURCE });

    await deleteGiteaRepo({ url: GITEA, token: "t" }, "me", "tool");

    expect(has("me", "tool")).toBe(false);
  });
});

describe.skipIf(!isChild)("locateOrphanMirror", () => {
  test("finds a recorded mirror where it is now after a rename on the destination", async () => {
    put({ owner: "me", name: "renamed", mirror: true, original_url: SOURCE });
    redirects.set(key("me", "tool"), "me/renamed");

    expect(await locateOrphanMirror(config(), row("me/tool"))).toEqual({ kind: "mirror", owner: "me", name: "renamed" });
  });

  test("trusts a mirror without original_url only at the recorded location", async () => {
    put({ owner: "me", name: "tool", mirror: true });

    expect((await locateOrphanMirror(config(), row("me/tool"))).kind).toBe("mirror");
    expect(await locateOrphanMirror(config(), row(""))).toEqual({
      kind: "not-ours",
      location: "me/tool",
      reason: "mirrors a different source",
      askedAt: "me/tool",
    });
  });

  test("a regular repository is never the orphan's mirror", async () => {
    put({ owner: "me", name: "tool", mirror: false });

    for (const location of ["me/tool", ""]) {
      expect(await locateOrphanMirror(config(), row(location))).toEqual({
        kind: "not-ours",
        location: "me/tool",
        reason: "is not a mirror",
        askedAt: "me/tool",
      });
    }
  });

  test("reports an empty address", async () => {
    expect(await locateOrphanMirror(config(), row("me/tool"))).toEqual({ kind: "absent", location: "me/tool" });
  });
});

describe.skipIf(!isChild)("handleOrphanedRepository on the destination", () => {
  test("deletes a renamed mirror at its new address, never through the old one", async () => {
    put({ owner: "me", name: "renamed", mirror: true, original_url: SOURCE });
    redirects.set(key("me", "tool"), "me/renamed");
    const notes: string[] = [];

    expect(await handleOrphanedRepository(config(), row("me/tool"), "delete", false, (note: string) => notes.push(note))).toBe(
      "deleted"
    );

    expect(has("me", "renamed")).toBe(false);
    expect(sent("DELETE")).toEqual(["/api/v1/repos/me/renamed"]);
    expect(notes).toEqual([]);
  });

  test("a row that was never mirrored leaves a regular repository of the same name alone", async () => {
    put({ owner: "me", name: "tool", mirror: false });
    const notes: string[] = [];

    expect(await handleOrphanedRepository(config(), row(""), "delete", false, (note: string) => notes.push(note))).toBe(
      "deleted"
    );

    expect(has("me", "tool")).toBe(true);
    expect(sent("DELETE")).toEqual([]);
    expect(notes).toEqual(["me/tool is not a mirror"]);
  });

  test("names the old address when a redirect led to a repository that is not ours", async () => {
    put({ owner: "me", name: "tool-old", mirror: false });
    redirects.set(key("me", "tool"), "me/tool-old");
    const notes: string[] = [];

    await handleOrphanedRepository(config(), row(""), "delete", false, (note: string) => notes.push(note));

    expect(has("me", "tool-old")).toBe(true);
    expect(sent("DELETE")).toEqual([]);
    expect(notes).toEqual(["me/tool-old is not a mirror (me/tool redirects here)"]);
  });

  test("leaves another source's mirror of the same name alone", async () => {
    put({ owner: "me", name: "tool", mirror: true, original_url: "https://github.com/other/tool.git" });

    await handleOrphanedRepository(config(), row(""), "delete", false);

    expect(has("me", "tool")).toBe(true);
    expect(sent("DELETE")).toEqual([]);
  });

  test("still deletes this source's mirror at the strategy's address", async () => {
    put({ owner: "me", name: "tool", mirror: true, original_url: SOURCE });

    await handleOrphanedRepository(config(), row(""), "delete", false);

    expect(has("me", "tool")).toBe(false);
  });

  test("leaves a regular repository that replaced the recorded mirror alone", async () => {
    put({ owner: "me", name: "tool", mirror: false });

    await handleOrphanedRepository(config(), row("me/tool"), "delete", false);

    expect(has("me", "tool")).toBe(true);
    expect(sent("DELETE")).toEqual([]);
  });

  test("archive never renames a regular repository", async () => {
    put({ owner: "me", name: "tool", mirror: false });
    const notes: string[] = [];

    expect(await handleOrphanedRepository(config(), row(""), "archive", false, (note: string) => notes.push(note))).toBe(
      "archived"
    );

    expect(sent("PATCH")).toEqual([]);
    expect(has("me", "tool")).toBe(true);
    expect(notes).toHaveLength(1);
  });

  test("archives a renamed mirror at its new address", async () => {
    put({ owner: "me", name: "renamed", mirror: true, original_url: SOURCE });
    redirects.set(key("me", "tool"), "me/renamed");

    await handleOrphanedRepository(config(), row("me/tool"), "archive", false);

    expect(sent("PATCH")[0]).toBe("/api/v1/repos/me/renamed");
    expect(has("me", "archived-renamed")).toBe(true);
  });

  test("with deleteFromGitea off the destination is not even asked", async () => {
    put({ owner: "me", name: "tool", mirror: true, original_url: SOURCE });

    await handleOrphanedRepository(config(false), row("me/tool"), "delete", false);

    expect(requests).toEqual([]);
  });
});

describe.skipIf(!isChild)("cleanup notification", () => {
  test("lists what was left alone on the destination", () => {
    const event = buildRepositoryCleanupNotificationEvent({
      action: "delete",
      destinationChanged: true,
      repositoryNames: ["acme/tool"],
      leftAlone: ["me/tool is not a mirror"],
      failures: [],
    });
    expect(event.message).toContain("On the destination, these were left alone:");
    expect(event.message).toContain("- me/tool is not a mirror");
  });
});
