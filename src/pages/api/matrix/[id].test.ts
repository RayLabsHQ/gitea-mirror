import { describe, expect, test } from "bun:test";
import { DELETE, GET, PUT } from "./[id]";

const authedLocals = { session: { userId: "user-1" } };
const params = { id: "pair-1" };

describe("PUT /api/matrix/[id] validation", () => {
  test("returns 400 for an invalid mirrorType", async () => {
    const request = new Request("http://localhost/api/matrix/pair-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mirrorType: "three-way" }),
    });

    const response = await PUT({ request, locals: authedLocals, params } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toContain("Invalid mirror pair payload");
  });

  test("returns 400 for invalid options", async () => {
    const request = new Request("http://localhost/api/matrix/pair-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        options: { destructiveProtection: { backupStrategy: "sometimes" } },
      }),
    });

    const response = await PUT({ request, locals: authedLocals, params } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
  });
});

describe("/api/matrix/[id] authentication", () => {
  test("GET returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/matrix/pair-1");

    const response = await GET({ request, locals: {}, params } as any);

    expect(response.status).toBe(401);
  });

  test("PUT returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/matrix/pair-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    const response = await PUT({ request, locals: {}, params } as any);

    expect(response.status).toBe(401);
  });

  test("DELETE returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/matrix/pair-1", {
      method: "DELETE",
    });

    const response = await DELETE({ request, locals: {}, params } as any);

    expect(response.status).toBe(401);
  });
});
