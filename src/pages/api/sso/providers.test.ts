/**
 * SSO provider management.
 *
 * GHSA-2hpx-83vg-gm45: the list returned the OIDC client secret, and any
 * user could change or delete any provider. The secret stays on the server.
 *
 * GHSA-c6c2-hr73-h7hw: providers apply to every account, so any user who
 * could add one could add it for another user's email domain and sign in as
 * them. Only the instance owner (the first account) manages providers now,
 * and sees all of them.
 *
 * Runs in an isolated child so the @/lib/db and auth mocks cannot leak into
 * other files (same harness as ../organizations/[id]/status.test.ts).
 */

import { describe, test, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const CHILD_FLAG = "GM_SSO_PROVIDERS_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("sso providers route (ownership) - isolated child suite", () => {
    const res = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, [CHILD_FLAG]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) {
      console.error(res.stdout.toString());
      console.error(res.stderr.toString());
    }
    expect(res.exitCode).toBe(0);
  }, 60_000);
}

const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite });

function applyMigrations(): void {
  const folder = join(process.cwd(), "drizzle");
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    const sql = readFileSync(join(folder, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.run(statement);
    }
  }
}

let currentUserId = "alice";

if (isChild) {
  applyMigrations();
  sqlite.run("PRAGMA foreign_keys = OFF");
  // alice signed up first, so she is the instance owner.
  sqlite.run("INSERT INTO users (id, email, username, name, created_at) VALUES ('alice', 'alice@example.com', 'alice', 'Alice', 1790000000)");
  sqlite.run("INSERT INTO users (id, email, username, name, created_at) VALUES ('bob', 'bob@example.com', 'bob', 'Bob', 1790000100)");

  mock.module("@/lib/utils/auth-helpers", () => ({
    requireAuth: mock(async () => ({ user: { id: currentUserId }, response: null })),
  }));

  mock.module("@/lib/db", () => ({ ...schema, db }));
}

const routes = isChild
  ? await import("./providers")
  : ({} as typeof import("./providers"));

function seed(id: string, userId: string, providerId: string) {
  sqlite.run(
    `INSERT INTO sso_providers (id, issuer, domain, oidc_config, user_id, provider_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "https://idp.example.com",
      "example.com",
      JSON.stringify({
        clientId: `client-${id}`,
        clientSecret: `secret-${id}`,
        authorizationEndpoint: "https://idp.example.com/auth",
        tokenEndpoint: "https://idp.example.com/token",
        jwksEndpoint: "https://idp.example.com/jwks",
        userInfoEndpoint: "https://idp.example.com/userinfo",
        scopes: ["openid"],
      }),
      userId,
      providerId,
      Date.now(),
      Date.now(),
    ]
  );
}

function ctx(method: string, query = "", body?: unknown) {
  return {
    request: new Request(`http://localhost/api/sso/providers${query}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as any;
}

function providerRow(id: string) {
  return sqlite
    .query("SELECT user_id, domain, domain_verified, oidc_config FROM sso_providers WHERE id = ?")
    .get(id) as { user_id: string; domain: string; domain_verified: number; oidc_config: string } | null;
}

describe.skipIf(!isChild)("SSO providers are managed by the instance owner", () => {
  test("the owner lists every provider, without client secrets", async () => {
    seed("p-alice", "alice", "alice-idp");
    // Added by bob before only the owner could; migration 0022 untrusted it.
    seed("p-bob", "bob", "bob-idp");
    sqlite.run("UPDATE sso_providers SET domain_verified = 0 WHERE id = 'p-bob'");

    currentUserId = "alice";
    const response = await routes.GET(ctx("GET"));
    expect(response.status).toBe(200);
    const list = (await response.json()) as any[];
    expect(list.map((p) => p.id).sort()).toEqual(["p-alice", "p-bob"]);
    expect(JSON.stringify(list)).not.toContain("secret-");
    const alice = list.find((p) => p.id === "p-alice");
    expect(alice.oidcConfig.hasClientSecret).toBe(true);
    expect(alice.oidcConfig.clientId).toBe("client-p-alice");
    expect(list.find((p) => p.id === "p-bob").domainVerified).toBe(false);
  });

  test("any other account gets 403 from every method and changes nothing", async () => {
    currentUserId = "bob";

    const list = await routes.GET(ctx("GET"));
    expect(list.status).toBe(403);
    expect((await list.json()).code).toBe("OWNER_ONLY");

    const created = await routes.POST(
      ctx("POST", "", {
        providerId: "victim-idp",
        issuer: "https://idp.attacker.example",
        domain: "example.com",
        clientId: "c",
        clientSecret: "s",
        authorizationEndpoint: "https://idp.attacker.example/auth",
        tokenEndpoint: "https://idp.attacker.example/token",
        jwksEndpoint: "https://idp.attacker.example/jwks",
      })
    );
    expect(created.status).toBe(403);
    const count = sqlite.query("SELECT count(*) AS n FROM sso_providers WHERE provider_id = 'victim-idp'").get() as any;
    expect(count.n).toBe(0);

    // Not even the provider bob added himself.
    const updated = await routes.PUT(ctx("PUT", "?id=p-bob", { domain: "evil.example" }));
    expect(updated.status).toBe(403);
    expect(providerRow("p-bob")?.domain).toBe("example.com");

    const deleted = await routes.DELETE(ctx("DELETE", "?id=p-alice"));
    expect(deleted.status).toBe(403);
    expect(providerRow("p-alice")).not.toBeNull();
  });

  test("PUT with an empty secret keeps the stored one", async () => {
    currentUserId = "alice";
    const response = await routes.PUT(
      ctx("PUT", "?id=p-alice", { domain: "alice.example", clientSecret: "" })
    );
    const body = await response.json();
    expect([response.status, body]).toEqual([200, expect.anything()]);
    expect(body.oidcConfig.clientSecret).toBeUndefined();
    expect(body.oidcConfig.hasClientSecret).toBe(true);

    const row = providerRow("p-alice");
    expect(row?.domain).toBe("alice.example");
    expect(JSON.parse(row!.oidc_config).clientSecret).toBe("secret-p-alice");
  });

  test("the owner saving another account's provider takes it over and trusts it again", async () => {
    currentUserId = "alice";
    const response = await routes.PUT(ctx("PUT", "?id=p-bob", { clientSecret: "" }));
    expect(response.status).toBe(200);

    const row = providerRow("p-bob");
    expect(row?.user_id).toBe("alice");
    expect(row?.domain_verified).toBe(1);
    expect(JSON.parse(row!.oidc_config).clientSecret).toBe("secret-p-bob");
  });

  test("the owner can delete any provider", async () => {
    seed("p-bob-2", "bob", "bob-idp-2");
    currentUserId = "alice";
    const response = await routes.DELETE(ctx("DELETE", "?id=p-bob-2"));
    expect(response.status).toBe(200);
    expect(providerRow("p-bob-2")).toBeNull();
  });

  test("an unknown id answers 404", async () => {
    currentUserId = "alice";
    expect((await routes.PUT(ctx("PUT", "?id=nope", { domain: "x.example" }))).status).toBe(404);
    expect((await routes.DELETE(ctx("DELETE", "?id=nope"))).status).toBe(404);
  });
});
