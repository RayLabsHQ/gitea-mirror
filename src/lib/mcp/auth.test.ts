import { describe, expect, test } from "bun:test";
import {
  authenticateMcpRequest,
  getMcpIssuerUrl,
  getMcpResourceUrl,
  resolveMcpPrincipal,
} from "./auth";

describe("MCP OAuth resource authentication", () => {
  test("requires an OAuth bearer token", async () => {
    const response = await authenticateMcpRequest(new Request("https://mirror.example/api/mcp"));
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect((response as Response).headers.get("www-authenticate")).toContain(
      "oauth-protected-resource",
    );
  });

  test("rejects a bearer token that is not signed by the OAuth server", async () => {
    const response = await authenticateMcpRequest(new Request("https://mirror.example/api/mcp", {
      headers: { Authorization: "Bearer not-a-jwt" },
    }));
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
  });

  test("uses the configured application origin and base path for its resource", () => {
    const originalUrl = process.env.BETTER_AUTH_URL;
    const originalBase = process.env.BASE_URL;
    process.env.BETTER_AUTH_URL = "https://mirror.example/auth/";
    process.env.BASE_URL = "/mirror";
    try {
      expect(getMcpResourceUrl()).toBe("https://mirror.example/mirror/api/mcp");
      expect(getMcpIssuerUrl()).toBe("https://mirror.example/mirror/api/auth");
    } finally {
      if (originalUrl === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = originalUrl;
      if (originalBase === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = originalBase;
    }
  });

  test("accepts only unexpired user tokens bound to this resource", () => {
    const resource = getMcpResourceUrl();
    const base = {
      sub: "user-1",
      aud: resource,
      scope: "mirror:read",
      exp: Math.floor(Date.now() / 1000) + 60,
      sid: "session-1",
      azp: "client-1",
    };
    expect(resolveMcpPrincipal(base)?.userId).toBe("user-1");
    expect(resolveMcpPrincipal({ ...base, sub: undefined })).toBeNull();
    expect(resolveMcpPrincipal({ ...base, exp: 0 })).toBeNull();
    expect(resolveMcpPrincipal({ ...base, aud: "https://other.example" })).toBeNull();
    expect(resolveMcpPrincipal({ ...base, scope: "openid profile" })).toBeNull();
    expect(resolveMcpPrincipal({ ...base, sid: undefined })).toBeNull();
  });
});
