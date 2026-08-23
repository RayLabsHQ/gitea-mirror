import { describe, expect, test } from "bun:test";
import { DELETE, GET, PUT } from "./[id]";

const authedLocals = { session: { userId: "user-1" } };
const params = { id: "srv-1" };

describe("PUT /api/servers/[id] validation", () => {
  test("returns 400 for an invalid payload", async () => {
    const request = new Request("http://localhost/api/servers/srv-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bitbucket" }),
    });

    const response = await PUT({ request, locals: authedLocals, params } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toContain("Invalid server payload");
  });

  test("returns 400 for an invalid url", async () => {
    const request = new Request("http://localhost/api/servers/srv-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });

    const response = await PUT({ request, locals: authedLocals, params } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
  });
});

describe("/api/servers/[id] authentication", () => {
  test("GET returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/servers/srv-1");

    const response = await GET({ request, locals: {}, params } as any);

    expect(response.status).toBe(401);
  });

  test("PUT returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/servers/srv-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    const response = await PUT({ request, locals: {}, params } as any);

    expect(response.status).toBe(401);
  });

  test("DELETE returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/servers/srv-1", {
      method: "DELETE",
    });

    const response = await DELETE({ request, locals: {}, params } as any);

    expect(response.status).toBe(401);
  });
});
