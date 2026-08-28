import { describe, expect, test } from "bun:test";
import { POST } from "./test";

const authedLocals = { session: { userId: "user-1" } };

describe("POST /api/servers/test validation", () => {
  test("returns 400 for an invalid server type", async () => {
    const request = new Request("http://localhost/api/servers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "bitbucket",
        username: "octo",
        token: "token",
        url: "https://bitbucket.org",
      }),
    });

    const response = await POST({ request, locals: authedLocals } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toContain("Invalid connection payload");
  });

  test("returns 400 when an HTTP provider has no token", async () => {
    const request = new Request("http://localhost/api/servers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "gitea",
        username: "octo",
        token: "",
        url: "https://gitea.example.com",
      }),
    });

    const response = await POST({ request, locals: authedLocals } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toBe("A personal access token is required");
  });
});

describe("POST /api/servers/test authentication", () => {
  test("returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/servers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        username: "octo",
        token: "token",
        url: "https://github.com",
      }),
    });

    const response = await POST({ request, locals: {} } as any);

    expect(response.status).toBe(401);
  });
});
