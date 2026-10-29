/**
 * Tests for the destination pager. Gitea 1.27.3 answered `per_page=100` with
 * 30 releases and `limit=50` with up to 50, plus `X-Total-Count`; the fake
 * destination below pages the same way.
 *
 * Several test files mock @/lib/http-client, and bun's mock.module leaks across
 * files, so this file re-runs itself in an isolated child to get the real one.
 */
import { describe, test, expect, afterEach } from "bun:test";

const CHILD_FLAG = "GM_DESTINATION_LISTING_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("destination listing - isolated child suite", () => {
    const res = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, [CHILD_FLAG]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) {
      console.error(res.stdout.toString());
      console.error(res.stderr.toString());
    }
    expect(res.exitCode).toBe(0);
  }, 60_000);
}

const { listDestinationPages, listDestinationReleases, listDestinationOwnerRepositories } = isChild
  ? await import("./destination-listing")
  : ({} as typeof import("./destination-listing"));

const realFetch = globalThis.fetch;
let requestedUrls: string[] = [];

/**
 * A destination holding `count` items that serves `pageCap` of them per page
 * at most, whatever `limit` asks for.
 */
function serve(
  count: number,
  { pageCap = 50, totalHeader = true, failPage }: { pageCap?: number; totalHeader?: boolean; failPage?: number } = {}
) {
  requestedUrls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    const params = new URL(url).searchParams;
    const page = Number(params.get("page") ?? "1");
    if (page === failPage) return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    const size = Math.min(Number(params.get("limit") ?? "30"), pageCap);
    const items = Array.from({ length: count }, (_, i) => ({ id: i + 1 })).slice((page - 1) * size, page * size);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (totalHeader) headers["x-total-count"] = String(count);
    return new Response(JSON.stringify(items), { status: 200, headers });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe.skipIf(!isChild)("listDestinationPages", () => {
  test("asks with limit and follows X-Total-Count past pages shorter than asked", async () => {
    serve(35, { pageCap: 30 });

    const listing = await listDestinationPages({ url: "https://gitea.example.com/api/v1/repos/o/r/releases", token: "t" });

    expect(listing.items).toHaveLength(35);
    expect(listing.complete).toBe(true);
    expect(requestedUrls).toEqual([
      "https://gitea.example.com/api/v1/repos/o/r/releases?limit=50&page=1",
      "https://gitea.example.com/api/v1/repos/o/r/releases?limit=50&page=2",
    ]);
  });

  test("ends on the page that reaches the total, without asking for an empty one", async () => {
    serve(100);

    const listing = await listDestinationPages({ url: "https://gitea.example.com/x", token: "t" });

    expect(listing.items).toHaveLength(100);
    expect(requestedUrls).toHaveLength(2);
  });

  test("without the total header, ends on a short page", async () => {
    serve(70, { totalHeader: false });

    const listing = await listDestinationPages({ url: "https://gitea.example.com/x", token: "t" });

    expect(listing.items).toHaveLength(70);
    expect(listing.complete).toBe(true);
    expect(requestedUrls).toHaveLength(2);
  });

  test("ends on an empty page", async () => {
    serve(0);

    const listing = await listDestinationPages({ url: "https://gitea.example.com/x", token: "t" });

    expect(listing).toEqual({ items: [], complete: true, truncated: false });
  });

  test("a failed page marks the listing incomplete and keeps what came before", async () => {
    serve(120, { failPage: 2 });

    const listing = await listDestinationPages({ url: "https://gitea.example.com/x", token: "t" });

    expect(listing.items).toHaveLength(50);
    expect(listing.complete).toBe(false);
  });

  test("stops at max and says whether more remained", async () => {
    serve(120);
    const capped = await listDestinationPages({ url: "https://gitea.example.com/x", token: "t", max: 60 });
    expect(capped.items).toHaveLength(60);
    expect(capped.truncated).toBe(true);
    expect(requestedUrls).toHaveLength(2);

    serve(60);
    const exact = await listDestinationPages({ url: "https://gitea.example.com/x", token: "t", max: 60 });
    expect(exact.items).toHaveLength(60);
    expect(exact.truncated).toBe(false);
  });

  test("sends the token", async () => {
    let authorization: string | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await listDestinationPages({ url: "https://gitea.example.com/x", token: "secret" });

    expect(authorization).toBe("token secret");
  });
});

describe.skipIf(!isChild)("listing URLs", () => {
  test("releases of one repository", async () => {
    serve(1);
    await listDestinationReleases({ baseUrl: "https://gitea.example.com/", token: "t", owner: "my org", repo: "app" });
    expect(requestedUrls[0]).toBe("https://gitea.example.com/api/v1/repos/my%20org/app/releases?limit=50&page=1");
  });

  test("repositories of one owner, user or organization", async () => {
    serve(1);
    await listDestinationOwnerRepositories({ baseUrl: "https://gitea.example.com", token: "t", owner: "archive" });
    expect(requestedUrls[0]).toBe("https://gitea.example.com/api/v1/users/archive/repos?limit=50&page=1");
  });
});
