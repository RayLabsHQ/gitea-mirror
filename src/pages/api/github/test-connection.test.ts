import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { runsIsolated } from "@/tests/isolated";

// The module mocks below would leak into the test files that run after
// this one, so the mocks and tests only run in a child process.
const isChild = runsIsolated(import.meta.path);

// createGitHubClient returns this stub. Tests mutate `getAuthenticatedImpl`
// to steer the behavior without re-calling mock.module (which is fragile
// once the route module has already captured a live binding).
let getAuthenticatedImpl: () => Promise<any> = () =>
  Promise.resolve({
    data: {
      login: "testuser",
      name: "Test User",
      avatar_url: "https://example.com/avatar.png",
    },
  });

/** Tokens the route handed to the GitHub client, in order. */
const clientTokens: string[] = [];

if (isChild) mock.module("@/lib/github", () => {
  return {
    createGitHubClient: mock((token: string) => {
      clientTokens.push(token);
      return {
        users: {
          getAuthenticated: mock(() => getAuthenticatedImpl()),
        },
      };
    }),
  };
});

// Saved sources, tokens "encrypted" with a prefix.
let sourceRows: any[] = [];
if (isChild) {
  const realSources = await import("@/lib/sources");
  mock.module("@/lib/sources", () => ({
    ...realSources,
    listSources: mock(async (userId: string) => sourceRows.filter((row) => row.userId === userId)),
    decryptSourceToken: mock((token: string | null | undefined) =>
      typeof token === "string" && token.startsWith("enc:") ? token.slice(4) : token ?? ""
    ),
  }));
}

import { POST } from "./test-connection";

describe.skipIf(!isChild)("GitHub Test Connection API", () => {
  // Mock console.error to prevent test output noise
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    originalConsoleError = console.error;
    console.error = mock(() => {});
    // Reset to the success stub before each test so tests are independent
    getAuthenticatedImpl = () =>
      Promise.resolve({
        data: {
          login: "testuser",
          name: "Test User",
          avatar_url: "https://example.com/avatar.png",
        },
      });
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test("returns 400 if token is missing", async () => {
    const request = new Request("http://localhost/api/github/test-connection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });

    const response = await POST({ request, locals: { user: { id: "user-1" } } } as any);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toBe("GitHub token is required");
  });

  test("returns 200 with user data on successful connection", async () => {
    const request = new Request("http://localhost/api/github/test-connection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        token: "valid-token"
      })
    });

    const response = await POST({ request, locals: { user: { id: "user-1" } } } as any);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe("Successfully connected to GitHub as testuser");
    expect(data.user).toEqual({
      login: "testuser",
      name: "Test User",
      avatar_url: "https://example.com/avatar.png"
    });
  });

  test("returns 400 if username doesn't match authenticated user", async () => {
    const request = new Request("http://localhost/api/github/test-connection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        token: "valid-token",
        username: "differentuser"
      })
    });

    const response = await POST({ request, locals: { user: { id: "user-1" } } } as any);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toBe("Token belongs to testuser, not differentuser");
  });

  test("handles authentication errors", async () => {
    // Swap the stub to throw an auth error for this test only
    getAuthenticatedImpl = () => Promise.reject(new Error("Bad credentials"));

    const request = new Request("http://localhost/api/github/test-connection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        token: "invalid-token"
      })
    });

    const response = await POST({ request, locals: { user: { id: "user-1" } } } as any);

    expect(response.status).toBe(500);

    const data = await response.json();
    // The createSecureErrorResponse function returns an error field, not success
    // It sanitizes error messages for security, so we expect the generic message
    expect(data.error).toBeDefined();
    expect(data.error).toBe("An internal server error occurred");
  });

  describe("a saved source", () => {
    const send = (body: Record<string, unknown>) =>
      POST({
        request: new Request("http://localhost/api/github/test-connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        locals: { user: { id: "user-1" } },
      } as any);

    beforeEach(() => {
      clientTokens.length = 0;
      sourceRows = [
        { id: "s1", userId: "user-1", provider: "github", url: "", username: "testuser", token: "enc:ghp_saved" },
        { id: "s2", userId: "user-2", provider: "github", url: "", username: "other", token: "enc:ghp_other" },
      ];
    });

    test("is tested with its saved token when the field is empty", async () => {
      const response = await send({ provider: "github", sourceId: "s1", token: "" });
      expect(response.status).toBe(200);
      expect(clientTokens).toEqual(["ghp_saved"]);
    });

    test("a typed token wins over the saved one", async () => {
      const response = await send({ provider: "github", sourceId: "s1", token: "ghp_typed" });
      expect(response.status).toBe(200);
      expect(clientTokens).toEqual(["ghp_typed"]);
    });

    test("its saved token is not sent to another origin", async () => {
      const response = await send({ provider: "gitea", url: "https://evil.example.net", sourceId: "s1", token: "" });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.message).toBe("Enter a Gitea / Forgejo token for https://evil.example.net. The saved one is only sent to https://github.com.");
      expect(clientTokens).toEqual([]);
    });

    test("another account's source is not found", async () => {
      const response = await send({ provider: "github", sourceId: "s2", token: "" });
      expect(response.status).toBe(400);
      expect((await response.json()).message).toBe("GitHub token is required");
      expect(clientTokens).toEqual([]);
    });
  });
});
