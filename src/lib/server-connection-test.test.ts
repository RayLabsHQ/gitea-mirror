import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { testServerConnection } from "./server-connection-test";

describe("testServerConnection", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses GitHub's authenticated user endpoint and bearer auth", async () => {
    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers;
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await testServerConnection(
      { type: "github", url: "https://github.com" },
      "github-token"
    );

    expect(result.success).toBe(true);
    expect(requestedUrl).toBe("https://api.github.com/user");
    expect(requestedHeaders).toEqual({
      Authorization: "Bearer github-token",
      Accept: "application/json",
    });
  });

  test("uses the configured GitLab URL and private-token auth", async () => {
    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers;
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await testServerConnection(
      { type: "gitlab", url: "https://gitlab.example.com/" },
      "gitlab-token"
    );

    expect(result.success).toBe(true);
    expect(requestedUrl).toBe("https://gitlab.example.com/api/v4/user");
    expect(requestedHeaders).toEqual({
      "PRIVATE-TOKEN": "gitlab-token",
      Accept: "application/json",
    });
  });

  test("uses the configured Gitea-compatible URL and token auth", async () => {
    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers;
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await testServerConnection(
      { type: "forgejo", url: "https://forgejo.example.com" },
      "forgejo-token"
    );

    expect(result.success).toBe(true);
    expect(requestedUrl).toBe("https://forgejo.example.com/api/v1/user");
    expect(requestedHeaders).toEqual({
      Authorization: "token forgejo-token",
      Accept: "application/json",
    });
  });

  test("reports authentication failures without throwing", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 401 })) as typeof globalThis.fetch;

    const result = await testServerConnection(
      { type: "gitea", url: "https://gitea.example.com" },
      "bad-token"
    );

    expect(result).toEqual({ success: false, message: "Authentication failed" });
  });
});
