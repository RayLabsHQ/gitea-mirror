import { describe, expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import {
  applyConditionalRequests,
  conditionalRequestCacheKey,
  InMemoryConditionalRequestStore,
} from "@/lib/github-conditional-requests";

function jsonResponse(
  body: unknown,
  init: { status: number; etag?: string; link?: string },
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (init.etag) headers.etag = init.etag;
  if (init.link) headers.link = init.link;
  return new Response(init.status === 304 ? null : JSON.stringify(body), {
    status: init.status,
    headers,
  });
}

function clientWithFetch(fetch: (url: string, init: any) => Promise<Response>) {
  return new Octokit({
    auth: "test-token",
    request: { fetch: fetch as unknown as typeof globalThis.fetch },
  });
}

describe("applyConditionalRequests", () => {
  test("replays If-None-Match and serves the cached body on 304", async () => {
    const etag = 'W/"abc123"';
    const pulls = [{ number: 1, title: "one" }];
    let calls = 0;
    let secondRequestIfNoneMatch: string | undefined;

    const octokit = clientWithFetch(async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(pulls, { status: 200, etag });
      }
      secondRequestIfNoneMatch = init?.headers?.["if-none-match"];
      return jsonResponse(null, { status: 304, etag });
    });
    applyConditionalRequests(octokit, {
      store: new InMemoryConditionalRequestStore(),
      scope: "user-1",
    });

    const first = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: "o",
      repo: "r",
      state: "all",
    });
    const second = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: "o",
      repo: "r",
      state: "all",
    });

    expect(calls).toBe(2);
    expect(secondRequestIfNoneMatch).toBe(etag);
    // A 304 is transparently presented as a 200 carrying the cached body.
    expect(second.status).toBe(200);
    expect(second.data).toEqual(first.data);
    expect(second.data).toEqual(pulls);
  });

  test("does not attach conditional headers to non-GET requests", async () => {
    let sawIfNoneMatch = false;
    const octokit = clientWithFetch(async (_url, init) => {
      if (init?.headers?.["if-none-match"]) sawIfNoneMatch = true;
      return jsonResponse({ ok: true }, { status: 201 });
    });
    applyConditionalRequests(octokit, {
      store: new InMemoryConditionalRequestStore(),
      scope: "user-1",
    });

    await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: "o",
      repo: "r",
      title: "x",
      head: "a",
      base: "b",
    });

    expect(sawIfNoneMatch).toBe(false);
  });

  test("makes a full request again when the response carries no ETag", async () => {
    let calls = 0;
    let secondRequestIfNoneMatch: string | undefined;
    const octokit = clientWithFetch(async (_url, init) => {
      calls += 1;
      if (calls >= 2) secondRequestIfNoneMatch = init?.headers?.["if-none-match"];
      return jsonResponse([{ number: 1 }], { status: 200 }); // no etag
    });
    applyConditionalRequests(octokit, {
      store: new InMemoryConditionalRequestStore(),
      scope: "user-1",
    });

    await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: "o",
      repo: "r",
    });
    const second = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: "o",
      repo: "r",
    });

    expect(calls).toBe(2);
    expect(secondRequestIfNoneMatch).toBeUndefined();
    expect(second.status).toBe(200);
  });

  test("isolates cached entries by scope", () => {
    const store = new InMemoryConditionalRequestStore();
    store.set(conditionalRequestCacheKey("user-1", "GET", "/x"), {
      etag: "a",
      data: 1,
      status: 200,
    });
    expect(
      store.get(conditionalRequestCacheKey("user-2", "GET", "/x")),
    ).toBeUndefined();
    expect(
      store.get(conditionalRequestCacheKey("user-1", "GET", "/x"))?.etag,
    ).toBe("a");
  });
});
