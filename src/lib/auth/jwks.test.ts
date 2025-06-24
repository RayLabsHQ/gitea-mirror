import { describe, test, expect, mock, beforeEach } from "bun:test";
import { extractKeyId, findKey, verifyJWTSignature } from "./jwks";

describe("JWKS Utilities", () => {
  test("extractKeyId extracts key ID from JWT header", () => {
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key-123" }));
    const payload = btoa(JSON.stringify({ sub: "user123" }));
    const signature = "mock-signature";
    const token = `${header}.${payload}.${signature}`;
    
    expect(extractKeyId(token)).toBe("test-key-123");
  });

  test("extractKeyId returns null for missing kid", () => {
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({ sub: "user123" }));
    const signature = "mock-signature";
    const token = `${header}.${payload}.${signature}`;
    
    expect(extractKeyId(token)).toBe(null);
  });

  test("findKey finds matching key by kid", () => {
    const jwks = {
      keys: [
        { kty: "RSA", kid: "key1", use: "sig" },
        { kty: "RSA", kid: "key2", use: "sig" },
        { kty: "RSA", kid: "key3", use: "enc" },
      ]
    };
    
    const key = findKey(jwks, "key2");
    expect(key).toBeTruthy();
    expect(key?.kid).toBe("key2");
  });

  test("findKey returns first signing key when no kid provided", () => {
    const jwks = {
      keys: [
        { kty: "RSA", kid: "key1", use: "enc" },
        { kty: "RSA", kid: "key2", use: "sig" },
        { kty: "RSA", kid: "key3" }, // No use specified
      ]
    };
    
    const key = findKey(jwks, null);
    expect(key).toBeTruthy();
    expect(key?.kid).toBe("key2");
  });

  test("findKey returns key without use when no signing key found", () => {
    const jwks = {
      keys: [
        { kty: "RSA", kid: "key1", use: "enc" },
        { kty: "RSA", kid: "key2" }, // No use specified
      ]
    };
    
    const key = findKey(jwks, null);
    expect(key).toBeTruthy();
    expect(key?.kid).toBe("key2");
  });
});