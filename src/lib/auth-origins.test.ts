import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveTrustedOrigins } from "./auth";

// Helper to create a mock Request with specific headers
function mockRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost:4321/api/auth/sign-in", {
    headers: new Headers(headers),
  });
}

describe("resolveTrustedOrigins", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of ["BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  test("includes localhost defaults when called without request", async () => {
    const origins = await resolveTrustedOrigins();
    expect(origins).toContain("http://localhost:4321");
    expect(origins).toContain("http://localhost:8080");
  });

  test("includes BETTER_AUTH_URL from env", async () => {
    process.env.BETTER_AUTH_URL = "https://gitea-mirror.example.com";
    const origins = await resolveTrustedOrigins();
    expect(origins).toContain("https://gitea-mirror.example.com");
  });

  test("includes BETTER_AUTH_TRUSTED_ORIGINS (comma-separated)", async () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://a.example.com, https://b.example.com";
    const origins = await resolveTrustedOrigins();
    expect(origins).toContain("https://a.example.com");
    expect(origins).toContain("https://b.example.com");
  });

  test("skips invalid URLs in env vars", async () => {
    process.env.BETTER_AUTH_URL = "not-a-url";
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "also-invalid, https://valid.example.com";
    const origins = await resolveTrustedOrigins();
    expect(origins).not.toContain("not-a-url");
    expect(origins).not.toContain("also-invalid");
    expect(origins).toContain("https://valid.example.com");
  });

  test("auto-detects origin from x-forwarded-host + x-forwarded-proto", async () => {
    const req = mockRequest({
      "x-forwarded-host": "gitea-mirror.mydomain.tld",
      "x-forwarded-proto": "https",
    });
    const origins = await resolveTrustedOrigins(req);
    expect(origins).toContain("https://gitea-mirror.mydomain.tld");
  });

  test("falls back to host header when x-forwarded-host is absent", async () => {
    const req = mockRequest({
      host: "myserver.local:4321",
    });
    const origins = await resolveTrustedOrigins(req);
    expect(origins).toContain("http://myserver.local:4321");
  });

  test("handles multi-value x-forwarded-host (chained proxies)", async () => {
    const req = mockRequest({
      "x-forwarded-host": "external.example.com, internal.proxy.local",
      "x-forwarded-proto": "https",
    });
    const origins = await resolveTrustedOrigins(req);
    expect(origins).toContain("https://external.example.com");
    expect(origins).not.toContain("https://internal.proxy.local");
  });

  test("handles multi-value x-forwarded-proto (chained proxies)", async () => {
    const req = mockRequest({
      "x-forwarded-host": "gitea.example.com",
      "x-forwarded-proto": "https, http",
    });
    const origins = await resolveTrustedOrigins(req);
    expect(origins).toContain("https://gitea.example.com");
    // Should NOT create an origin with "https, http" as proto
    expect(origins).not.toContain("https, http://gitea.example.com");
  });

  test("rejects invalid x-forwarded-proto values", async () => {
    const req = mockRequest({
      "x-forwarded-host": "gitea.example.com",
      "x-forwarded-proto": "ftp",
    });
    const origins = await resolveTrustedOrigins(req);
    expect(origins).not.toContain("ftp://gitea.example.com");
  });

  test("deduplicates origins", async () => {
    process.env.BETTER_AUTH_URL = "http://localhost:4321";
    const origins = await resolveTrustedOrigins();
    const count = origins.filter(o => o === "http://localhost:4321").length;
    expect(count).toBe(1);
  });

  test("defaults proto to http when x-forwarded-proto is absent", async () => {
    const req = mockRequest({
      "x-forwarded-host": "gitea.internal",
    });
    const origins = await resolveTrustedOrigins(req);
    expect(origins).toContain("http://gitea.internal");
  });
});
