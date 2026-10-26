import { describe, expect, test } from "bun:test";
import { ApiError, GiteaMirrorClient } from "./client";
import { API_KEY, BASE_URL, fakeApi } from "./test-helpers";

function clientFor(routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi(routes);
  return { client: new GiteaMirrorClient({ baseUrl: `${BASE_URL}/`, apiKey: API_KEY, fetch: api.fetch }), calls: api.calls };
}

describe("GiteaMirrorClient", () => {
  test("sends the key on reads and a JSON content type on writes", async () => {
    const { client, calls } = clientFor({
      "GET /api/github/repositories": () => ({ body: { repositories: [] } }),
      "POST /api/job/sync-repo": () => ({ body: { success: true } }),
    });

    await client.get("/api/github/repositories");
    await client.post("/api/job/sync-repo", { repositoryIds: ["r1"] });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/github/repositories",
      "POST /api/job/sync-repo",
    ]);
    expect(calls[0].headers.get("x-api-key")).toBe(API_KEY);
    expect(calls[0].headers.get("content-type")).toBeNull();
    expect(calls[1].headers.get("x-api-key")).toBe(API_KEY);
    expect(calls[1].headers.get("content-type")).toBe("application/json");
    expect(calls[1].body).toEqual({ repositoryIds: ["r1"] });
  });

  test("returns accepted error statuses instead of throwing", async () => {
    const { client } = clientFor({
      "POST /api/sync/repository": () => ({ status: 409, body: { repository: { id: "r1" } } }),
    });
    await expect(client.post("/api/sync/repository", {}, [409])).resolves.toEqual({
      status: 409,
      body: { repository: { id: "r1" } },
    });
    await expect(client.post("/api/sync/repository", {})).rejects.toThrow(/failed with 409/);
  });

  test("explains a rejected key without echoing it", async () => {
    const { client } = clientFor({
      "GET /api/github/repositories": () => ({ status: 401, body: { success: false, error: "Unauthorized" } }),
    });
    const error = (await client.get("/api/github/repositories").catch((caught) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.message).toContain("GITEA_MIRROR_API_KEY");
    expect(error.message).not.toContain(API_KEY);
  });

  test("passes the app's error text and code through", async () => {
    const { client } = clientFor({
      "POST /api/job/sync-repo": () => ({
        status: 403,
        body: { success: false, error: "This API key is read only.", code: "API_KEY_READ_ONLY" },
      }),
    });
    const error = await client.post("/api/job/sync-repo", {}).catch((caught) => caught);
    expect(error.status).toBe(403);
    expect(error.code).toBe("API_KEY_READ_ONLY");
    expect(error.message).toBe("POST /api/job/sync-repo failed with 403: This API key is read only.");
  });

  test("points at the URL when the answer is not JSON", async () => {
    const { client } = clientFor({
      "GET /api/github/repositories": () => new Response("<!doctype html><title>Not Found</title>", { status: 404 }),
    });
    await expect(client.get("/api/github/repositories")).rejects.toThrow(/GITEA_MIRROR_URL is the address of the app/);
  });

  test("reports an unreachable app", async () => {
    const client = new GiteaMirrorClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(client.get("/api/github/repositories")).rejects.toThrow(
      `Could not reach Gitea Mirror at ${BASE_URL}: fetch failed`
    );
  });
});
