/**
 * Instance-wide SSO settings belong to the instance owner, the first account
 * (GHSA-c6c2-hr73-h7hw). Any signed-in user could register an identity
 * provider for another user's email domain and sign in as them; the OAuth
 * applications list showed every client to every user.
 *
 * Covers the routes not in providers.test.ts: provider registration, OIDC
 * discovery and OAuth applications. Runs in its own process because it
 * mocks @/lib/db, @/lib/auth and the auth helper.
 */

import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { runsIsolated } from "@/tests/isolated";

const isChild = runsIsolated(import.meta.path);

const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite });
let currentUserId = "owner";

const registerSSOProvider = mock(async () => ({ providerId: "registered" }));
const createOAuthClient = mock(async () => ({ client_id: "new-client" }));
const updateOAuthClient = mock(async () => ({ client_id: "c-1" }));
const deleteOAuthClient = mock(async () => ({ success: true }));

if (isChild) {
  const folder = join(process.cwd(), "drizzle");
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    for (const statement of readFileSync(join(folder, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.run(statement);
    }
  }
  sqlite.run("PRAGMA foreign_keys = OFF");
  // Inserted out of order on purpose: the owner is the earliest created_at.
  sqlite.run("INSERT INTO users (id, email, username, name, created_at) VALUES ('member', 'm@victim.example', 'member', 'Member', 1790000100)");
  sqlite.run("INSERT INTO users (id, email, username, name, created_at) VALUES ('owner', 'o@victim.example', 'owner', 'Owner', 1790000000)");
  // Same second as the owner (created_at has whole seconds) and an id that
  // sorts first: still not the owner, because it was inserted later.
  sqlite.run("INSERT INTO users (id, email, username, name, created_at) VALUES ('aaa-same-second', 's@victim.example', 'same', 'Same', 1790000000)");
  sqlite.run(
    `INSERT INTO oauth_clients (id, client_id, name, redirect_uris, created_at, updated_at)
     VALUES ('oc-1', 'c-1', 'Wiki', '["https://wiki.example/callback"]', 1790000200, 1790000200),
            ('oc-2', 'c-2', 'Grafana', '["https://grafana.example/login"]', 1790000300, 1790000300)`
  );

  mock.module("@/lib/utils/auth-helpers", () => ({
    requireAuth: mock(async () => ({ user: { id: currentUserId }, response: null })),
  }));
  mock.module("@/lib/db", () => ({ ...schema, db }));
  mock.module("@/lib/auth", () => ({
    auth: { api: { registerSSOProvider, createOAuthClient, updateOAuthClient, deleteOAuthClient } },
  }));
}

const register = isChild ? await import("../auth/sso/register") : ({} as typeof import("../auth/sso/register"));
const discover = isChild ? await import("./discover") : ({} as typeof import("./discover"));
const applications = isChild ? await import("./applications") : ({} as typeof import("./applications"));

function ctx(path: string, method: string, body?: unknown) {
  const url = `http://localhost${path}`;
  return {
    request: new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    url: new URL(url),
  } as any;
}

const attackerProvider = {
  providerId: "mallory-idp",
  issuer: "https://idp.attacker.example",
  domain: "victim.example",
  clientId: "mirror-client",
  clientSecret: "attacker-secret",
  authorizationEndpoint: "https://idp.attacker.example/authorize",
  tokenEndpoint: "https://idp.attacker.example/token",
  jwksEndpoint: "https://idp.attacker.example/jwks",
  // With every endpoint and scopes given, nothing is fetched from the issuer.
  userInfoEndpoint: "https://idp.attacker.example/userinfo",
  scopes: ["openid", "email", "profile"],
};

describe.skipIf(!isChild)("only the instance owner manages instance-wide SSO settings", () => {
  test("a member cannot register a provider for the owner's domain", async () => {
    currentUserId = "member";
    const response = await register.POST(ctx("/api/auth/sso/register", "POST", attackerProvider));

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("OWNER_ONLY");
    expect(registerSSOProvider).not.toHaveBeenCalled();
    const rows = sqlite.query("SELECT count(*) AS n FROM sso_providers").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("an account created in the same second as the owner is not the owner", async () => {
    currentUserId = "aaa-same-second";
    const response = await register.POST(ctx("/api/auth/sso/register", "POST", attackerProvider));
    expect(response.status).toBe(403);
    expect(registerSSOProvider).not.toHaveBeenCalled();
  });

  test("the owner can register one, trusted for its domain", async () => {
    currentUserId = "owner";
    const response = await register.POST(
      ctx("/api/auth/sso/register", "POST", { ...attackerProvider, providerId: "company-idp" })
    );

    expect(response.status).toBe(201);
    expect(registerSSOProvider).toHaveBeenCalledTimes(1);
    const row = sqlite
      .query("SELECT user_id, domain_verified FROM sso_providers WHERE provider_id = 'company-idp'")
      .get() as { user_id: string; domain_verified: number };
    expect(row).toEqual({ user_id: "owner", domain_verified: 1 });
  });

  test("a member cannot use OIDC discovery", async () => {
    currentUserId = "member";
    const response = await discover.POST(ctx("/api/sso/discover", "POST", { issuer: "https://idp.attacker.example" }));
    expect(response.status).toBe(403);
  });

  test("a member cannot list, create, change or delete OAuth applications", async () => {
    currentUserId = "member";

    expect((await applications.GET(ctx("/api/sso/applications", "GET"))).status).toBe(403);
    expect(
      (await applications.POST(ctx("/api/sso/applications", "POST", { name: "x", redirectURLs: ["https://x.example"] }))).status
    ).toBe(403);
    expect(
      (await applications.PUT(ctx("/api/sso/applications?id=c-1", "PUT", { redirectURLs: ["https://evil.example/cb"] }))).status
    ).toBe(403);
    expect((await applications.DELETE(ctx("/api/sso/applications?id=c-1", "DELETE"))).status).toBe(403);

    expect(createOAuthClient).not.toHaveBeenCalled();
    expect(updateOAuthClient).not.toHaveBeenCalled();
    expect(deleteOAuthClient).not.toHaveBeenCalled();
  });

  test("anyone signed in can look up the one application they are approving", async () => {
    currentUserId = "member";
    const response = await applications.GET(ctx("/api/sso/applications?clientId=c-1", "GET"));

    expect(response.status).toBe(200);
    const list = (await response.json()) as { clientId: string; name: string; redirectURLs: string }[];
    expect(list.map((app) => [app.clientId, app.name, app.redirectURLs])).toEqual([
      ["c-1", "Wiki", "https://wiki.example/callback"],
    ]);
  });

  test("the owner lists every application", async () => {
    currentUserId = "owner";
    const response = await applications.GET(ctx("/api/sso/applications", "GET"));

    expect(response.status).toBe(200);
    const list = (await response.json()) as { clientId: string }[];
    expect(list.map((app) => app.clientId).sort()).toEqual(["c-1", "c-2"]);
  });
});
