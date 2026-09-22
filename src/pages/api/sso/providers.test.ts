/**
 * SSO provider ownership (GHSA-2hpx-83vg-gm45).
 *
 * The routes authenticated the caller but read, updated and deleted
 * providers by id across every user, and the list returned the OIDC client
 * secret. Every query is now scoped to the caller and the secret stays on
 * the server.
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

describe.skipIf(!isChild)("SSO providers ownership", () => {
  test("GET lists only the caller's providers and never the client secret", async () => {
    seed("p-alice", "alice", "alice-idp");
    seed("p-bob", "bob", "bob-idp");

    currentUserId = "alice";
    const response = await routes.GET(ctx("GET"));
    expect(response.status).toBe(200);
    const list = (await response.json()) as any[];
    expect(list.map((p) => p.id)).toEqual(["p-alice"]);
    expect(JSON.stringify(list)).not.toContain("secret-");
    expect(list[0].oidcConfig.hasClientSecret).toBe(true);
    expect(list[0].oidcConfig.clientId).toBe("client-p-alice");
  });

  test("PUT on another user's provider answers 404 and changes nothing", async () => {
    currentUserId = "alice";
    const response = await routes.PUT(ctx("PUT", "?id=p-bob", { domain: "evil.example" }));
    expect(response.status).toBe(404);

    const row = sqlite.query("SELECT domain, oidc_config FROM sso_providers WHERE id = 'p-bob'").get() as any;
    expect(row.domain).toBe("example.com");
    expect(JSON.parse(row.oidc_config).clientSecret).toBe("secret-p-bob");
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

    const row = sqlite.query("SELECT domain, oidc_config FROM sso_providers WHERE id = 'p-alice'").get() as any;
    expect(row.domain).toBe("alice.example");
    expect(JSON.parse(row.oidc_config).clientSecret).toBe("secret-p-alice");
  });

  test("DELETE on another user's provider answers 404 and keeps the row", async () => {
    currentUserId = "alice";
    const response = await routes.DELETE(ctx("DELETE", "?id=p-bob"));
    expect(response.status).toBe(404);
    const count = sqlite.query("SELECT count(*) AS n FROM sso_providers WHERE id = 'p-bob'").get() as any;
    expect(count.n).toBe(1);
  });

  test("DELETE on the caller's own provider works", async () => {
    currentUserId = "bob";
    const response = await routes.DELETE(ctx("DELETE", "?id=p-bob"));
    expect(response.status).toBe(200);
    const count = sqlite.query("SELECT count(*) AS n FROM sso_providers WHERE id = 'p-bob'").get() as any;
    expect(count.n).toBe(0);
  });
});
