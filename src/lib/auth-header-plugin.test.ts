import { describe, expect, test } from "bun:test";
import { headerAuthPlugin } from "./auth-header-plugin";

describe("headerAuthPlugin", () => {
  test("registers the `header-auth` plugin id", () => {
    const plugin = headerAuthPlugin();
    expect(plugin.id).toBe("header-auth");
  });

  test("exposes a `signInWithHeader` endpoint", () => {
    const plugin = headerAuthPlugin();
    expect(plugin.endpoints?.signInWithHeader).toBeDefined();
  });

  test("mounts the endpoint at POST /sign-in/header", () => {
    // The Astro API route is /api/auth/<plugin-path>, so the resolved
    // URL the middleware bridge talks to is /api/auth/sign-in/header.
    // Locking that path down in a test prevents an accidental rename
    // from silently breaking the React SPA's auth flow.
    const plugin = headerAuthPlugin();
    const endpoint = plugin.endpoints?.signInWithHeader as unknown as {
      path: string;
      options: { method: string };
    };

    expect(endpoint.path).toBe("/sign-in/header");
    expect(endpoint.options.method).toBe("POST");
  });
});
