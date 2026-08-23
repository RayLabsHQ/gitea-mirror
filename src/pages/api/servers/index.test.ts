import { describe, expect, test } from "bun:test";
import { GET, POST } from "./index";

const authedLocals = { session: { userId: "user-1" } };

describe("POST /api/servers validation", () => {
  test("returns 400 for an unknown server type", async () => {
    const request = new Request("http://localhost/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bitbucket",
        type: "bitbucket",
        username: "octo",
        token: "tok",
        url: "https://bitbucket.org",
      }),
    });

    const response = await POST({ request, locals: authedLocals } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toContain("Invalid server payload");
  });

  test("returns 400 for an invalid url", async () => {
    const request = new Request("http://localhost/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Gitea",
        type: "gitea",
        username: "octo",
        token: "tok",
        url: "not-a-url",
      }),
    });

    const response = await POST({ request, locals: authedLocals } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
  });
});

describe("/api/servers authentication", () => {
  test("GET returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/servers");

    const response = await GET({ request, locals: {} } as any);

    expect(response.status).toBe(401);
  });

  test("POST returns 401 when unauthenticated", async () => {
    const request = new Request("http://localhost/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "GitHub",
        type: "github",
        username: "octo",
        token: "ghp_x",
        url: "https://github.com",
      }),
    });

    const response = await POST({ request, locals: {} } as any);

    expect(response.status).toBe(401);
  });
});
