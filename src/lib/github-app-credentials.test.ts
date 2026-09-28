import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { encodeGitHubAppCredentials, parseGitHubAppCredentials, resolveGitHubAccessToken } from "./github-app-credentials";

test("GitHub App credentials round-trip without confusing PATs", () => {
  const credentials = { appId: "123", installationId: "456", privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----" };
  expect(parseGitHubAppCredentials(encodeGitHubAppCredentials(credentials))).toEqual(credentials);
  expect(parseGitHubAppCredentials("ghp_pat")).toBeNull();
  expect(() => parseGitHubAppCredentials("github-app:v1:broken")).toThrow();
});

test("installation tokens are minted, cached and never substituted for a PAT", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const credential = encodeGitHubAppCredentials({ appId: "123", installationId: "456", privateKey });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (input, init) => {
    requests++;
    expect(String(input)).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(init?.headers).toHaveProperty("Authorization");
    return new Response(JSON.stringify({ token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
  }) as typeof fetch;
  try {
    expect(await resolveGitHubAccessToken(credential)).toBe("ghs_test");
    expect(await resolveGitHubAccessToken(credential)).toBe("ghs_test");
    expect(requests).toBe(1);
    expect(await resolveGitHubAccessToken("ghp_pat")).toBe("ghp_pat");
  } finally {
    globalThis.fetch = originalFetch;
  }
});