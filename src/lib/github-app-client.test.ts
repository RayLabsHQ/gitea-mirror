import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubAppClient } from "@/lib/github-app-client";
import { encodeGitHubAppCredentials } from "@/lib/github-app-credentials";

const originalFetch = globalThis.fetch;

interface StubbedCall {
  ifNoneMatch?: string;
  authorization?: string;
}

function jsonResponse(
  body: unknown,
  init: { status: number; etag?: string }
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (init.etag) headers.etag = init.etag;
  return new Response(init.status === 304 ? null : JSON.stringify(body), {
    status: init.status,
    headers,
  });
}

function appCredential(appId: string): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return encodeGitHubAppCredentials({
    appId,
    installationId: "987",
    privateKey,
  });
}

/**
 * Serves the installation token exchange, then answers like GitHub does once
 * the request carries an ETag: 200 with the body the first time, 304 after.
 * Only the repository requests are recorded, so the assertions are about the
 * calls the cache is meant to save.
 */
function stubAppFetch(body: unknown, etag: string): { calls: StubbedCall[] } {
  const calls: StubbedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "ghs_installation",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }

    const headers = new Headers(init?.headers);
    const ifNoneMatch = headers.get("if-none-match") ?? undefined;
    calls.push({
      ifNoneMatch,
      authorization: headers.get("authorization") ?? undefined,
    });
    return ifNoneMatch
      ? jsonResponse(null, { status: 304, etag })
      : jsonResponse(body, { status: 200, etag });
  }) as typeof globalThis.fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createGitHubAppClient", () => {
  test("replays If-None-Match on a repeat GET and serves the cached body", async () => {
    const etag = 'W/"app-etag-one"';
    const repo = { full_name: "octo/app-etag-one", description: "cached" };
    const { calls } = stubAppFetch(repo, etag);
    const octokit = createGitHubAppClient(appCredential("101"), {
      userId: "app-etag-user-one",
    });

    const first = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "octo",
      repo: "app-etag-one",
    });
    const second = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "octo",
      repo: "app-etag-one",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].ifNoneMatch).toBeUndefined();
    expect(calls[1].ifNoneMatch).toBe(etag);
    expect(calls[1].authorization).toBe("token ghs_installation");
    // A 304 is transparently presented as a 200 carrying the cached body.
    expect(second.status).toBe(200);
    expect(second.data).toEqual(first.data);
    expect(second.data).toMatchObject(repo);
  });

  test("keeps the cache across clients built from the same credential", async () => {
    const etag = 'W/"app-etag-two"';
    const { calls } = stubAppFetch({ ok: true }, etag);
    const credential = appCredential("102");
    const request = () =>
      createGitHubAppClient(credential).request("GET /repos/{owner}/{repo}", {
        owner: "octo",
        repo: "app-etag-two",
      });

    // No userId: the scope falls back to a hash of the credential, so the
    // fresh client a later sync builds still finds the previous ETag.
    const first = await request();
    const second = await request();

    expect(calls).toHaveLength(2);
    expect(calls[1].ifNoneMatch).toBe(etag);
    expect(second.status).toBe(200);
    expect(second.data).toEqual(first.data);
  });

  test("does not reuse the cache across users", async () => {
    const etag = 'W/"app-etag-three"';
    const { calls } = stubAppFetch({ ok: true }, etag);
    const credential = appCredential("103");
    const request = (userId: string) =>
      createGitHubAppClient(credential, { userId }).request(
        "GET /repos/{owner}/{repo}",
        { owner: "octo", repo: "app-etag-three" }
      );

    await request("app-etag-user-three");
    await request("app-etag-user-other");

    expect(calls).toHaveLength(2);
    // Same URL and credential, different user: a separate cache entry, so the
    // second client has nothing to replay.
    expect(calls[1].ifNoneMatch).toBeUndefined();
  });
});
