import { describe, expect, test } from "bun:test";
import { authenticateMcpRequest, getMcpResourceUrl, resolveMcpPrincipal } from "./auth";

describe("MCP OAuth resource authentication", () => {
  test("requires an OAuth bearer token", async () => {
    const response = await authenticateMcpRequest(new Request("https://mirror.example/api/mcp"));
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect((response as Response).headers.get("www-authenticate")).toContain(
      "oauth-protected-resource",
    );
  });

  test("uses the configured application origin and base path for its resource", () => {
    const originalUrl = process.env.BETTER_AUTH_URL;
    const originalBase = process.env.BASE_URL;
    process.env.BETTER_AUTH_URL = "https://mirror.example/auth/";
    process.env.BASE_URL = "/mirror";
    try {
      expect(getMcpResourceUrl()).toBe("https://mirror.example/mirror/api/mcp");
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
      userId: "user-1",
      scopes: JSON.stringify(["mirror:read"]),
      resources: JSON.stringify([resource]),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(resolveMcpPrincipal(base)?.userId).toBe("user-1");
    expect(resolveMcpPrincipal({ ...base, userId: null })).toBeNull();
    expect(resolveMcpPrincipal({ ...base, expiresAt: new Date(0) })).toBeNull();
    expect(resolveMcpPrincipal({ ...base, resources: JSON.stringify(["https://other.example"]) })).toBeNull();
    expect(resolveMcpPrincipal({ ...base, scopes: "not-json" })).toBeNull();
  });
});
