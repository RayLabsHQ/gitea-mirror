/**
 * 06 – API keys.
 *
 * Creates a personal API key through the Better Auth endpoint, calls the
 * app with the key in the x-api-key header instead of a session cookie,
 * then revokes it and checks the key stops working.
 */

import { test, expect } from "@playwright/test";
import { APP_URL, APP_USER_EMAIL, getAppSessionCookies } from "./helpers";

const KEY_HEADER = "x-api-key";

test.describe("E2E: API keys", () => {
  let cookies = "";
  let keyId = "";
  let secret = "";

  test("Step 1: create a key with the session", async ({ request }) => {
    cookies = await getAppSessionCookies(request);
    expect(cookies).toBeTruthy();

    const resp = await request.post(`${APP_URL}/api/auth/api-key/create`, {
      headers: { Cookie: cookies, "Content-Type": "application/json" },
      data: { name: "e2e-key" },
      failOnStatusCode: false,
    });
    expect(resp.status(), await resp.text()).toBe(200);
    const body = await resp.json();
    keyId = body.id;
    secret = body.key;
    expect(keyId).toBeTruthy();
    expect(secret.startsWith("gm_")).toBeTruthy();
    expect(secret.length).toBeGreaterThan(64);
    expect(body.expiresAt).toBeNull();
    expect(body.rateLimitEnabled).toBe(false);
    console.log(`[ApiKeys] Created key ${body.start}… (${keyId})`);
  });

  test("Step 2: the key resolves to the user's session", async ({ request }) => {
    const resp = await request.get(`${APP_URL}/api/auth/get-session`, {
      headers: { [KEY_HEADER]: secret },
      failOnStatusCode: false,
    });
    expect(resp.status(), await resp.text()).toBe(200);
    const session = await resp.json();
    expect(session?.user?.email).toBe(APP_USER_EMAIL);
  });

  test("Step 3: app routes accept the key without a cookie", async ({ request }) => {
    const resp = await request.get(`${APP_URL}/api/github/repositories`, {
      headers: { [KEY_HEADER]: secret },
      failOnStatusCode: false,
    });
    // 200 once a configuration exists (spec 02 saves one); never a 401.
    expect(resp.status()).not.toBe(401);
    expect(resp.status()).toBeLessThan(500);
    if (resp.status() === 200) {
      const body = await resp.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.repositories)).toBeTruthy();
      console.log(`[ApiKeys] Listed ${body.repositories.length} repositories with the key`);
    }
  });

  test("Step 4: missing, malformed and unknown keys are rejected", async ({ request }) => {
    const noKey = await request.get(`${APP_URL}/api/github/repositories`, {
      failOnStatusCode: false,
    });
    expect(noKey.status()).toBe(401);

    const shortKey = await request.get(`${APP_URL}/api/github/repositories`, {
      headers: { [KEY_HEADER]: "gm_not-a-real-key" },
      failOnStatusCode: false,
    });
    expect(shortKey.status()).toBe(401);

    const unknownKey = await request.get(`${APP_URL}/api/github/repositories`, {
      headers: { [KEY_HEADER]: `gm_${"a".repeat(64)}` },
      failOnStatusCode: false,
    });
    expect(unknownKey.status()).toBe(401);
  });

  test("Step 4b: a key cannot create, list or revoke keys", async ({ request }) => {
    const create = await request.post(`${APP_URL}/api/auth/api-key/create`, {
      headers: { [KEY_HEADER]: secret, "Content-Type": "application/json" },
      data: { name: "minted-by-a-key" },
      failOnStatusCode: false,
    });
    expect(create.status(), await create.text()).toBe(403);

    const list = await request.get(`${APP_URL}/api/auth/api-key/list`, {
      headers: { [KEY_HEADER]: secret },
      failOnStatusCode: false,
    });
    expect(list.status()).toBe(403);

    const del = await request.post(`${APP_URL}/api/auth/api-key/delete`, {
      headers: { [KEY_HEADER]: secret, "Content-Type": "application/json" },
      data: { keyId },
      failOnStatusCode: false,
    });
    expect(del.status()).toBe(403);
  });

  test("Step 5: the list shows the key start and usage, never the secret", async ({ request }) => {
    const resp = await request.get(`${APP_URL}/api/auth/api-key/list`, {
      headers: { Cookie: cookies },
      failOnStatusCode: false,
    });
    expect(resp.status(), await resp.text()).toBe(200);
    const body = (await resp.json()) as { apiKeys: Array<Record<string, unknown>>; total: number };
    expect(Array.isArray(body.apiKeys)).toBeTruthy();
    expect(body.total).toBeGreaterThanOrEqual(1);
    const row = body.apiKeys.find((candidate) => candidate.id === keyId);
    expect(row).toBeTruthy();
    expect(row!.key).toBeUndefined();
    expect(typeof row!.start).toBe("string");
    expect(secret.startsWith(row!.start as string)).toBeTruthy();
    expect(row!.lastRequest).toBeTruthy();
    expect(row!.name).toBe("e2e-key");
  });

  test("Step 6: revoking the key stops it working", async ({ request }) => {
    const del = await request.post(`${APP_URL}/api/auth/api-key/delete`, {
      headers: { Cookie: cookies, "Content-Type": "application/json" },
      data: { keyId },
      failOnStatusCode: false,
    });
    expect(del.status(), await del.text()).toBe(200);

    const resp = await request.get(`${APP_URL}/api/github/repositories`, {
      headers: { [KEY_HEADER]: secret },
      failOnStatusCode: false,
    });
    expect(resp.status()).toBe(401);

    const session = await request.get(`${APP_URL}/api/auth/get-session`, {
      headers: { [KEY_HEADER]: secret },
      failOnStatusCode: false,
    });
    expect(session.status()).not.toBe(200);
    console.log("[ApiKeys] Revoked key is rejected");
  });
});
