import { describe, expect, test } from "bun:test";
import { APIError } from "better-auth/api";
import {
  apiKeyGuardPlugin,
  apiKeyManagementForbidden,
  isApiKeyManagementRequest,
} from "./auth-api-key-guard";

const withKey = () => new Headers({ "x-api-key": "gm_" + "a".repeat(64) });

describe("isApiKeyManagementRequest", () => {
  test("matches key endpoints called with the key header", () => {
    expect(isApiKeyManagementRequest("/api-key/create", withKey())).toBe(true);
    expect(isApiKeyManagementRequest("/api-key/list", withKey())).toBe(true);
    expect(isApiKeyManagementRequest("/api-key/delete", withKey())).toBe(true);
    expect(isApiKeyManagementRequest("/api-key/update", withKey())).toBe(true);
  });

  test("lets cookie sessions manage keys", () => {
    expect(isApiKeyManagementRequest("/api-key/create", new Headers())).toBe(false);
    expect(isApiKeyManagementRequest("/api-key/list", new Headers({ cookie: "better-auth.session_token=x" }))).toBe(false);
  });

  test("ignores the header on every other endpoint", () => {
    expect(isApiKeyManagementRequest("/get-session", withKey())).toBe(false);
    expect(isApiKeyManagementRequest("/sign-in/email", withKey())).toBe(false);
    expect(isApiKeyManagementRequest("/api-keys-look-alike", withKey())).toBe(false);
  });

  test("treats a blank header and missing context as no key", () => {
    expect(isApiKeyManagementRequest("/api-key/create", new Headers({ "x-api-key": "   " }))).toBe(false);
    expect(isApiKeyManagementRequest(undefined, withKey())).toBe(false);
    expect(isApiKeyManagementRequest("/api-key/create", undefined)).toBe(false);
  });
});

describe("apiKeyGuardPlugin", () => {
  test("registers one before hook under the api-key-guard id", () => {
    const plugin = apiKeyGuardPlugin();
    expect(plugin.id).toBe("api-key-guard");
    expect(plugin.hooks.before).toHaveLength(1);
  });

  test("the hook matcher only fires for key management with a key", () => {
    const [hook] = apiKeyGuardPlugin().hooks.before;
    expect(hook.matcher({ path: "/api-key/create", headers: withKey() } as any)).toBe(true);
    expect(hook.matcher({ path: "/api-key/create", headers: new Headers() } as any)).toBe(false);
    expect(hook.matcher({ path: "/get-session", headers: withKey() } as any)).toBe(false);
  });

  test("refuses with a 403 and a stable code", () => {
    const error = apiKeyManagementForbidden();
    expect(error).toBeInstanceOf(APIError);
    expect(error.status).toBe("FORBIDDEN");
    expect(error.body?.code).toBe("API_KEY_CANNOT_MANAGE_KEYS");
    expect(error.message).toContain("Sign in");
  });
});
