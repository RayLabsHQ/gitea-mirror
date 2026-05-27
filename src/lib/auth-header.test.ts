import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  extractUserFromHeaders,
  isHeaderAuthEnabled,
  getHeaderAuthConfig,
} from "./auth-header";

// `auth-header` reads config from `process.env` at call time. We snapshot
// the relevant keys and restore them after each test so cases don't bleed.
const HEADER_ENV_KEYS = [
  "HEADER_AUTH_ENABLED",
  "HEADER_AUTH_AUTO_PROVISION",
  "HEADER_AUTH_USER_HEADER",
  "HEADER_AUTH_EMAIL_HEADER",
  "HEADER_AUTH_NAME_HEADER",
  "HEADER_AUTH_ALLOWED_DOMAINS",
] as const;

let savedEnv: Partial<Record<(typeof HEADER_ENV_KEYS)[number], string | undefined>> = {};

function setEnv(vars: Partial<Record<(typeof HEADER_ENV_KEYS)[number], string>>) {
  for (const key of HEADER_ENV_KEYS) {
    if (key in vars) {
      process.env[key] = vars[key]!;
    } else {
      delete process.env[key];
    }
  }
}

beforeEach(() => {
  savedEnv = Object.fromEntries(
    HEADER_ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as typeof savedEnv;
});

afterEach(() => {
  for (const key of HEADER_ENV_KEYS) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

describe("isHeaderAuthEnabled", () => {
  test("returns false when HEADER_AUTH_ENABLED is unset", () => {
    setEnv({});
    expect(isHeaderAuthEnabled()).toBe(false);
  });

  test("returns false when HEADER_AUTH_ENABLED is anything other than the string 'true'", () => {
    setEnv({ HEADER_AUTH_ENABLED: "1" });
    expect(isHeaderAuthEnabled()).toBe(false);
    setEnv({ HEADER_AUTH_ENABLED: "yes" });
    expect(isHeaderAuthEnabled()).toBe(false);
  });

  test("returns true only for HEADER_AUTH_ENABLED='true' exactly", () => {
    setEnv({ HEADER_AUTH_ENABLED: "true" });
    expect(isHeaderAuthEnabled()).toBe(true);
  });
});

describe("extractUserFromHeaders", () => {
  test("returns null when header auth is disabled", () => {
    setEnv({});
    const headers = new Headers({ "X-Authentik-Username": "u" });
    expect(extractUserFromHeaders(headers)).toBeNull();
  });

  test("returns null when the configured user header is absent", () => {
    setEnv({ HEADER_AUTH_ENABLED: "true" });
    const headers = new Headers({ "X-Some-Other-Header": "u" });
    expect(extractUserFromHeaders(headers)).toBeNull();
  });

  test("returns username, email, and name from default Authentik headers", () => {
    setEnv({ HEADER_AUTH_ENABLED: "true" });
    const headers = new Headers({
      "X-Authentik-Username": "alice",
      "X-Authentik-Email": "alice@example.com",
      "X-Authentik-Name": "Alice Q",
    });

    expect(extractUserFromHeaders(headers)).toEqual({
      username: "alice",
      email: "alice@example.com",
      name: "Alice Q",
    });
  });

  test("respects HEADER_AUTH_USER_HEADER override (Caddy / caddy-security style)", () => {
    setEnv({
      HEADER_AUTH_ENABLED: "true",
      HEADER_AUTH_USER_HEADER: "X-Token-User-Email",
      HEADER_AUTH_EMAIL_HEADER: "X-Token-User-Email",
      HEADER_AUTH_NAME_HEADER: "X-Token-User-Name",
    });
    const headers = new Headers({
      "X-Token-User-Email": "bob@example.com",
      "X-Token-User-Name": "Bob",
    });

    // lanrat's reported config: username and email are both pulled from
    // the same header. Both should resolve to that value.
    expect(extractUserFromHeaders(headers)).toEqual({
      username: "bob@example.com",
      email: "bob@example.com",
      name: "Bob",
    });
  });

  test("rejects when email domain is not on the allow list", () => {
    setEnv({
      HEADER_AUTH_ENABLED: "true",
      HEADER_AUTH_ALLOWED_DOMAINS: "example.com,corp.example",
    });
    const headers = new Headers({
      "X-Authentik-Username": "evil",
      "X-Authentik-Email": "evil@elsewhere.test",
    });

    expect(extractUserFromHeaders(headers)).toBeNull();
  });

  test("accepts when email domain matches the allow list", () => {
    setEnv({
      HEADER_AUTH_ENABLED: "true",
      HEADER_AUTH_ALLOWED_DOMAINS: "example.com,corp.example",
    });
    const headers = new Headers({
      "X-Authentik-Username": "alice",
      "X-Authentik-Email": "alice@corp.example",
    });

    expect(extractUserFromHeaders(headers)).toEqual({
      username: "alice",
      email: "alice@corp.example",
      name: undefined,
    });
  });
});

describe("getHeaderAuthConfig", () => {
  test("merges env overrides over defaults without leaking unset env values", () => {
    setEnv({
      HEADER_AUTH_ENABLED: "true",
      HEADER_AUTH_USER_HEADER: "X-Forwarded-User",
    });

    const config = getHeaderAuthConfig();
    expect(config.enabled).toBe(true);
    expect(config.userHeader).toBe("X-Forwarded-User");
    // Unset overrides should fall back to defaults, not become undefined.
    expect(config.emailHeader).toBe("X-Authentik-Email");
    expect(config.nameHeader).toBe("X-Authentik-Name");
  });
});
