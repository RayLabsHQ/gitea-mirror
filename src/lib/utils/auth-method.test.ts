import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  LAST_AUTH_METHOD_STORAGE_KEY,
  isAuthMethod,
  parseDefaultAuthMethod,
  resolveInitialAuthMethod,
  getLastAuthMethod,
  setLastAuthMethod,
} from "./auth-method";

const BOTH = { email: true, sso: true };
const EMAIL_ONLY = { email: true, sso: false };
const SSO_ONLY = { email: false, sso: true };

describe("parseDefaultAuthMethod", () => {
  test("accepts the two known values", () => {
    expect(parseDefaultAuthMethod("email")).toBe("email");
    expect(parseDefaultAuthMethod("sso")).toBe("sso");
  });

  test("ignores case and surrounding whitespace", () => {
    expect(parseDefaultAuthMethod(" SSO ")).toBe("sso");
    expect(parseDefaultAuthMethod("Email")).toBe("email");
  });

  test("falls back to email for anything else", () => {
    expect(parseDefaultAuthMethod(undefined)).toBe("email");
    expect(parseDefaultAuthMethod(null)).toBe("email");
    expect(parseDefaultAuthMethod("")).toBe("email");
    expect(parseDefaultAuthMethod("oidc")).toBe("email");
    expect(parseDefaultAuthMethod(42)).toBe("email");
  });
});

describe("isAuthMethod", () => {
  test("recognises only the two methods", () => {
    expect(isAuthMethod("email")).toBe(true);
    expect(isAuthMethod("sso")).toBe(true);
    expect(isAuthMethod("saml")).toBe(false);
    expect(isAuthMethod(null)).toBe(false);
  });
});

describe("resolveInitialAuthMethod", () => {
  test("uses the remembered method when it is available", () => {
    expect(
      resolveInitialAuthMethod({
        remembered: "sso",
        serverDefault: "email",
        available: BOTH,
      })
    ).toBe("sso");
    expect(
      resolveInitialAuthMethod({
        remembered: "email",
        serverDefault: "sso",
        available: BOTH,
      })
    ).toBe("email");
  });

  test("ignores a remembered method that is no longer available", () => {
    expect(
      resolveInitialAuthMethod({
        remembered: "sso",
        serverDefault: "email",
        available: EMAIL_ONLY,
      })
    ).toBe("email");
  });

  test("uses the server default when nothing is remembered", () => {
    expect(
      resolveInitialAuthMethod({ serverDefault: "sso", available: BOTH })
    ).toBe("sso");
    expect(
      resolveInitialAuthMethod({
        remembered: null,
        serverDefault: "sso",
        available: BOTH,
      })
    ).toBe("sso");
  });

  test("falls back to email when the server default is unavailable", () => {
    expect(
      resolveInitialAuthMethod({ serverDefault: "sso", available: EMAIL_ONLY })
    ).toBe("email");
  });

  test("falls back to sso when email is unavailable", () => {
    expect(
      resolveInitialAuthMethod({ serverDefault: "email", available: SSO_ONLY })
    ).toBe("sso");
    expect(
      resolveInitialAuthMethod({
        remembered: "email",
        serverDefault: "email",
        available: SSO_ONLY,
      })
    ).toBe("sso");
  });

  test("defaults to email when no server default is given", () => {
    expect(resolveInitialAuthMethod({ available: BOTH })).toBe("email");
  });
});

// The Bun test runtime has no DOM. Install a minimal localStorage shim for the
// storage tests and remove it afterwards.
const g = globalThis as any;
const createdLocalStorage = typeof g.localStorage === "undefined";

beforeAll(() => {
  if (createdLocalStorage) {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };
  }
});

afterAll(() => {
  if (createdLocalStorage) {
    delete g.localStorage;
  }
});

describe("last auth method storage", () => {
  beforeEach(() => {
    g.localStorage.clear();
  });

  test("round trips a stored method", () => {
    setLastAuthMethod("sso");
    expect(getLastAuthMethod()).toBe("sso");
    setLastAuthMethod("email");
    expect(getLastAuthMethod()).toBe("email");
  });

  test("returns null when nothing is stored", () => {
    expect(getLastAuthMethod()).toBeNull();
  });

  test("ignores a bogus stored value", () => {
    g.localStorage.setItem(LAST_AUTH_METHOD_STORAGE_KEY, "carrier-pigeon");
    expect(getLastAuthMethod()).toBeNull();
  });

  test("swallows storage errors", () => {
    const original = g.localStorage;
    g.localStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    try {
      expect(getLastAuthMethod()).toBeNull();
      expect(() => setLastAuthMethod("sso")).not.toThrow();
    } finally {
      g.localStorage = original;
    }
  });
});
