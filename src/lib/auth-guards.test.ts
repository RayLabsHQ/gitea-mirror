import { describe, expect, mock, test } from "bun:test";

const getSessionMock = mock(async () => null);

mock.module("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: getSessionMock,
    },
  },
}));

import { requireAuthenticatedUserId } from "./auth-guards";

describe("requireAuthenticatedUserId", () => {
  test("returns user id from locals session without calling auth api", async () => {
    getSessionMock.mockImplementation(async () => {
      throw new Error("should not be called");
    });

    const result = await requireAuthenticatedUserId({
      request: new Request("http://localhost/test"),
      locals: {
        session: { userId: "local-user-id" },
      } as any,
    });

    expect("userId" in result).toBe(true);
    if ("userId" in result) {
      expect(result.userId).toBe("local-user-id");
    }
  });

  test("returns user id from auth session when locals are empty", async () => {
    getSessionMock.mockImplementation(async () => ({
      user: { id: "session-user-id" },
      session: { id: "session-id" },
    }));

    const result = await requireAuthenticatedUserId({
      request: new Request("http://localhost/test"),
      locals: {} as any,
    });

    expect("userId" in result).toBe(true);
    if ("userId" in result) {
      expect(result.userId).toBe("session-user-id");
    }
  });

  test("returns unauthorized response when auth lookup throws", async () => {
    getSessionMock.mockImplementation(async () => {
      throw new Error("session provider unavailable");
    });

    const result = await requireAuthenticatedUserId({
      request: new Request("http://localhost/test"),
      locals: {} as any,
    });

    expect("response" in result).toBe(true);
    if ("response" in result) {
      expect(result.response.status).toBe(401);
    }
  });
});
