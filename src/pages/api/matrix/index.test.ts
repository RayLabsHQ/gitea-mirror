import { describe, expect, test } from "bun:test";
import { GET, POST } from "./index";

const authedLocals = { session: { userId: "user-1" } };

describe("POST /api/matrix validation", () => {
  test("returns 400 for an unknown mirrorType", async () => {
    const request = new Request("http://localhost/api/matrix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceServerId: "srv-1",
        targetServerId: "srv-2",
        username: "octo",
        mirrorType: "three-way",
      }),
    });

    const response = await POST({ request, locals: authedLocals } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toContain("Invalid mirror pair payload");
  });

  test("returns 400 when targetServerId is missing", async () => {
    const request = new Request("http://localhost/api/matrix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceServerId: "srv-1",
        username: "octo",
      }),
    });

    const response = await POST({ request, locals: authedLocals } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
  });

  test("returns 400 for invalid options", async () => {
    const request = new Request("http://localhost/api/matrix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceServerId: "srv-1",
        targetServerId: "srv-2",
        username: "octo",
        options: { repositorySelection: { mode: "everything" } },
      }),
    });

    const response = await POST({ request, locals: authedLocals } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
  });
});

describe("/api/matrix authentication", () => {
  test("GET returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/matrix");

    const response = await GET({ request, locals: {} } as any);

    expect(response.status).toBe(401);
  });

  test("POST returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/matrix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceServerId: "srv-1",
        targetServerId: "srv-2",
        username: "octo",
      }),
    });

    const response = await POST({ request, locals: {} } as any);

    expect(response.status).toBe(401);
  });
});
