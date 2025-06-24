import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { validateTrustedProxy } from "./forward-auth";
import { decodeIdToken } from "./oidc";
import { ENV } from "@/lib/config";

describe("Forward Auth Security", () => {
  const originalTrustedProxies = ENV.AUTH.FORWARD.TRUSTED_PROXIES;

  beforeEach(() => {
    // Reset to original value
    ENV.AUTH.FORWARD.TRUSTED_PROXIES = [];
  });

  afterEach(() => {
    // Restore original value
    ENV.AUTH.FORWARD.TRUSTED_PROXIES = originalTrustedProxies;
  });

  test("validateTrustedProxy allows all when no proxies configured", () => {
    const request = new Request("http://localhost/test");
    expect(validateTrustedProxy(request)).toBe(true);
  });

  test("validateTrustedProxy checks the last proxy in X-Forwarded-For", () => {
    ENV.AUTH.FORWARD.TRUSTED_PROXIES = ["10.0.0.5"];
    
    const request = new Request("http://localhost/test", {
      headers: {
        "X-Forwarded-For": "192.168.1.100, 10.0.0.3, 10.0.0.5"
      }
    });
    
    // Should return true because 10.0.0.5 is the last proxy and is trusted
    expect(validateTrustedProxy(request)).toBe(true);
  });

  test("validateTrustedProxy rejects untrusted proxy", () => {
    ENV.AUTH.FORWARD.TRUSTED_PROXIES = ["10.0.0.5"];
    
    const request = new Request("http://localhost/test", {
      headers: {
        "X-Forwarded-For": "192.168.1.100, 10.0.0.3, 10.0.0.6"
      }
    });
    
    // Should return false because 10.0.0.6 is not in trusted list
    expect(validateTrustedProxy(request)).toBe(false);
  });
});

describe("OIDC Security", () => {
  test("decodeIdToken validates issuer", () => {
    // Create a mock ID token with wrong issuer
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({
      sub: "user123",
      iss: "https://wrong-issuer.com",
      exp: Math.floor(Date.now() / 1000) + 3600
    }));
    const signature = "mock-signature";
    const token = `${header}.${payload}.${signature}`;
    
    expect(() => {
      decodeIdToken(token, "https://correct-issuer.com");
    }).toThrow("ID token issuer mismatch");
  });

  test("decodeIdToken validates expiration", () => {
    // Create an expired token
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({
      sub: "user123",
      iss: "https://issuer.com",
      exp: Math.floor(Date.now() / 1000) - 3600 // Expired 1 hour ago
    }));
    const signature = "mock-signature";
    const token = `${header}.${payload}.${signature}`;
    
    expect(() => {
      decodeIdToken(token, "https://issuer.com");
    }).toThrow("ID token expired");
  });

  test("decodeIdToken accepts valid token", () => {
    const issuer = "https://issuer.com";
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({
      sub: "user123",
      iss: issuer,
      exp: Math.floor(Date.now() / 1000) + 3600
    }));
    const signature = "mock-signature";
    const token = `${header}.${payload}.${signature}`;
    
    const decoded = decodeIdToken(token, issuer);
    expect(decoded.sub).toBe("user123");
    expect(decoded.iss).toBe(issuer);
  });
});