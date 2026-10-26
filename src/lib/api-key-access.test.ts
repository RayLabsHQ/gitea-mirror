import { describe, expect, test } from "bun:test";
import { needsWriteAccess, refuseReadOnlyApiKey } from "./api-key-access";
import { API_KEY_HEADER } from "./api-keys";

const KEY_ID = "key-1";

function keyRequest(method: string, path: string, withKey = true): Request {
  return new Request(`http://localhost:4321${path}`, {
    method,
    headers: withKey ? { [API_KEY_HEADER]: "gm_secret" } : {},
  });
}

async function check(
  method: string,
  path: string,
  metadata: unknown,
  options: { withKey?: boolean; sessionId?: string | null } = {}
) {
  const lookups: string[] = [];
  const response = await refuseReadOnlyApiKey({
    request: keyRequest(method, path, options.withKey ?? true),
    pathname: path,
    sessionId: options.sessionId === undefined ? KEY_ID : options.sessionId,
    lookupMetadata: async (keyId) => {
      lookups.push(keyId);
      return metadata;
    },
  });
  return { response, lookups };
}

describe("needsWriteAccess", () => {
  test("reads pass, every other method needs write access", () => {
    expect(needsWriteAccess("GET", "/api/github/repositories")).toBe(false);
    expect(needsWriteAccess("head", "/api/repositories/abc")).toBe(false);
    expect(needsWriteAccess("OPTIONS", "/api/job/sync-repo")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(needsWriteAccess(method, "/api/repositories/abc")).toBe(true);
    }
  });

  test("Better Auth endpoints need write access except the session lookup", () => {
    expect(needsWriteAccess("GET", "/api/auth/get-session")).toBe(false);
    expect(needsWriteAccess("GET", "/api/auth/oauth2/authorize")).toBe(true);
    expect(needsWriteAccess("GET", "/api/auth/list-sessions")).toBe(true);
    expect(needsWriteAccess("GET", "/api/auth")).toBe(true);
    // A route that only starts with the same letters is an app route.
    expect(needsWriteAccess("GET", "/api/authors")).toBe(false);
  });
});

describe("refuseReadOnlyApiKey", () => {
  test("refuses a write from a read only key with a JSON 403", async () => {
    const { response, lookups } = await check("POST", "/api/job/sync-repo", '{"access":"read"}');
    expect(response?.status).toBe(403);
    expect(response?.headers.get("content-type")).toBe("application/json");
    expect(await response?.json()).toEqual({
      success: false,
      error: "This API key is read only. Use a key with full access to make changes.",
      code: "API_KEY_READ_ONLY",
    });
    expect(lookups).toEqual([KEY_ID]);
  });

  test("lets a read only key read without looking the key up", async () => {
    const { response, lookups } = await check("GET", "/api/github/repositories", { access: "read" });
    expect(response).toBeNull();
    expect(lookups).toEqual([]);
  });

  test("lets full access keys write, including keys made before access levels", async () => {
    expect((await check("POST", "/api/job/sync-repo", null)).response).toBeNull();
    expect((await check("DELETE", "/api/repositories", { access: "full" })).response).toBeNull();
  });

  test("leaves cookie sessions and unresolved keys alone", async () => {
    const cookie = await check("POST", "/api/job/sync-repo", { access: "read" }, { withKey: false });
    expect(cookie.response).toBeNull();
    expect(cookie.lookups).toEqual([]);

    // A key the plugin rejected leaves no session; the route answers 401.
    const unresolved = await check("POST", "/api/job/sync-repo", { access: "read" }, { sessionId: null });
    expect(unresolved.response).toBeNull();
    expect(unresolved.lookups).toEqual([]);
  });

  test("refuses when the key row cannot be found", async () => {
    const { response } = await check("POST", "/api/job/sync-repo", undefined);
    expect(response?.status).toBe(403);
  });
});
