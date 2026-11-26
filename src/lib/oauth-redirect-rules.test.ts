import { describe, expect, test } from "bun:test";
import { applicationTypeOf, redirectUriProblem, type ApplicationType } from "./oauth-redirect-rules";

describe("OAuth application redirect URL rules", () => {
  // Each verdict was checked against better-auth 1.7's own client
  // registration (POST /api/auth/oauth2/create-client). If an upgrade changes
  // the plugin's rules, check this table against it again.
  const cases: [ApplicationType, string, boolean][] = [
    ["web", "https://wiki.example/cb", true],
    ["web", "https://wiki.example:8443/oauth/callback?x=1", true],
    ["web", "http://wiki.example/cb", false],
    ["web", "http://grafana.lan:3000/login", false],
    ["web", "https://localhost/cb", false],
    ["web", "http://localhost:3000/cb", false],
    ["web", "https://127.0.0.1/cb", false],
    ["web", "http://127.0.0.2/cb", false],
    ["web", "https://[::1]/cb", false],
    ["web", "https://app.localhost/cb", true],
    ["web", "https://wiki.example/cb#frag", false],
    ["web", "https://user:pw@wiki.example/cb", false],
    ["web", "com.example.app:/cb", false],
    ["web", "javascript:alert(1)", false],
    ["native", "https://wiki.example/cb", true],
    ["native", "https://localhost/cb", false],
    ["native", "http://localhost:9000/cb", true],
    ["native", "http://127.0.0.1:8400/cb", true],
    ["native", "http://[::1]:8400/cb", true],
    ["native", "http://127.0.0.2/cb", false],
    ["native", "http://grafana.lan/cb", false],
    ["native", "http://app.localhost/cb", false],
    ["native", "com.example.cli:/oauth", true],
    ["native", "com.example.cli://oauth", false],
    ["native", "myapp:/cb", false],
    ["native", "file:/etc/passwd", false],
    ["native", "mailto.x.y:/a", true],
    ["native", "https://127.0.0.1/cb", false],
  ];

  test.each(cases)("%s %s allowed: %p", (type, uri, allowed) => {
    expect(redirectUriProblem(uri, type) === null).toBe(allowed);
  });

  test("the messages say what to do", () => {
    expect(redirectUriProblem("http://grafana.lan:3000/login", "web")).toBe(
      "http://grafana.lan:3000/login must use https: web applications need an https redirect URL",
    );
    expect(redirectUriProblem("http://localhost:3000/cb", "web")).toContain('Send type "native"');
    expect(redirectUriProblem("http://grafana.lan/cb", "native")).toContain("http only for localhost, 127.0.0.1 or [::1]");
    expect(redirectUriProblem("myapp:/cb", "native")).toContain("com.example.app:/callback");
  });

  test("rows from better-auth 1.6 keep their type in the old column", () => {
    expect(applicationTypeOf({ applicationType: "native" })).toBe("native");
    expect(applicationTypeOf({ applicationType: null, type: "native" })).toBe("native");
    expect(applicationTypeOf({ applicationType: null, type: "user-agent-based" })).toBe("web");
    expect(applicationTypeOf({})).toBe("web");
  });
});
