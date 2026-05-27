import { describe, expect, mock, test, beforeEach } from "bun:test";

// Stub `./auth` so we can drive the response shape `mintSessionFromHeaders`
// sees from the plugin endpoint without standing up the full Better Auth
// stack + DB.
const signInWithHeaderMock = mock<(args: unknown) => Promise<Response>>(
  async () => new Response(null, { status: 500 }),
);

mock.module("@/lib/auth", () => ({
  auth: {
    api: {
      signInWithHeader: signInWithHeaderMock,
    },
  },
}));

import { mintSessionFromHeaders } from "./auth-header-bridge";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/test", { headers });
}

describe("mintSessionFromHeaders", () => {
  beforeEach(() => {
    signInWithHeaderMock.mockReset();
  });

  test("returns user, session, and Set-Cookie values on a 200 response", async () => {
    signInWithHeaderMock.mockImplementation(async () => {
      const response = new Response(
        JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          session: { id: "sess-1", userId: "user-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      // Modern runtimes coalesce multiple Set-Cookie via append.
      response.headers.append("set-cookie", "better-auth-session=abc; Path=/");
      response.headers.append("set-cookie", "better-auth-remember=1; Path=/");
      return response;
    });

    const result = await mintSessionFromHeaders(makeRequest());

    expect(result).not.toBeNull();
    expect(result?.user.id).toBe("user-1");
    expect(result?.session.id).toBe("sess-1");
    expect(result?.setCookies).toEqual([
      "better-auth-session=abc; Path=/",
      "better-auth-remember=1; Path=/",
    ]);
  });

  test("returns null when the endpoint responds non-2xx (header auth disabled / unauthorized)", async () => {
    signInWithHeaderMock.mockImplementation(
      async () => new Response("Unauthorized", { status: 401 }),
    );

    const result = await mintSessionFromHeaders(makeRequest());

    expect(result).toBeNull();
  });

  test("returns null when the endpoint throws (transient failure)", async () => {
    signInWithHeaderMock.mockImplementation(async () => {
      throw new Error("upstream unreachable");
    });

    const result = await mintSessionFromHeaders(makeRequest());

    expect(result).toBeNull();
  });

  test("returns null when the response body is missing user or session", async () => {
    signInWithHeaderMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ token: "abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await mintSessionFromHeaders(makeRequest());

    expect(result).toBeNull();
  });

  test("returns null when the body is malformed JSON", async () => {
    signInWithHeaderMock.mockImplementation(
      async () =>
        new Response("not json at all", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await mintSessionFromHeaders(makeRequest());

    expect(result).toBeNull();
  });

  test("returns an empty setCookies array when no Set-Cookie headers were attached", async () => {
    // Defensive — should never happen in practice because the plugin
    // always calls setSessionCookie. If it does happen, we still want
    // the user/session to come through so SSR works on this request.
    signInWithHeaderMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            user: { id: "user-1" },
            session: { id: "sess-1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await mintSessionFromHeaders(makeRequest());

    expect(result).not.toBeNull();
    expect(result?.setCookies).toEqual([]);
  });
});
