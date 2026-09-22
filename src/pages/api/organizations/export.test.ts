/**
 * Route tests for GET /api/organizations/export: the auth guard, the header
 * row, RFC 4180 escaping of an error message and scoping to the signed in
 * user (#428).
 *
 * Runs against the real schema in an in-memory SQLite database. The route
 * imports @/lib/db, which is replaced with that database through
 * mock.module; bun's mock.module is process-wide and leaks into other test
 * files, so this file registers nothing in the shared process and re-runs
 * itself in an isolated child (same harness as ./[id]/status.test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const CHILD_FLAG = "GM_ORGANIZATIONS_EXPORT_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("organizations CSV export route - isolated child suite", () => {
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

/** Apply every migration in drizzle/ in journal order, the way the migrator would. */
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

/** Flipped by the unauthenticated test. */
let authenticatedUserId: string | null = "user-1";

if (isChild) {
  applyMigrations();
  // The seed below only needs the organizations table.
  sqlite.run("PRAGMA foreign_keys = OFF");

  mock.module("@/lib/auth-guards", () => ({
    requireAuthenticatedUserId: mock(async () =>
      authenticatedUserId
        ? { userId: authenticatedUserId }
        : {
            response: new Response(
              JSON.stringify({ success: false, error: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ),
          }
    ),
  }));

  mock.module("@/lib/db", () => ({ ...schema, db }));
}

const routeModule = isChild
  ? await import("./export")
  : ({} as Partial<typeof import("./export")>);
const GET = routeModule.GET as NonNullable<typeof routeModule.GET>;
const ORGANIZATION_EXPORT_COLUMNS = routeModule.ORGANIZATION_EXPORT_COLUMNS ?? [];

const EXPECTED_HEADER =
  "name,membershipRole,isIncluded,destinationOrg,status,repositoryCount," +
  "publicRepositoryCount,privateRepositoryCount,forkRepositoryCount," +
  "lastMirrored,errorMessage,createdAt,updatedAt";

const CREATED_AT = 1_690_000_000;
const MIRRORED_AT = 1_700_000_000;

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function get() {
  return GET({
    params: {},
    request: new Request("http://localhost/api/organizations/export"),
    locals: { session: { userId: "user-1" } },
  } as any);
}

type OrgSeed = {
  id: string;
  userId?: string;
  name: string;
  errorMessage?: string | null;
};

function seedOrg({ id, userId = "user-1", name, errorMessage = null }: OrgSeed) {
  sqlite.run(
    `INSERT INTO organizations (
       id, user_id, config_id, name, normalized_name, avatar_url, membership_role,
       is_included, destination_org, status, repository_count, public_repository_count,
       private_repository_count, fork_repository_count, last_mirrored, error_message,
       created_at, updated_at
     ) VALUES (?, ?, 'config-1', ?, ?, 'https://avatars.example.com/a.png', 'admin',
       1, 'mirrors', 'mirrored', 7, 5,
       2, 1, ?, ?,
       ?, ?)`,
    [
      id,
      userId,
      name,
      name.toLowerCase(),
      MIRRORED_AT,
      errorMessage,
      CREATED_AT,
      MIRRORED_AT,
    ]
  );
}

beforeEach(() => {
  if (!isChild) return;
  authenticatedUserId = "user-1";
  sqlite.run("DELETE FROM organizations");
});

describe.skipIf(!isChild)("GET /api/organizations/export", () => {
  test("answers 401 when the request is not authenticated", async () => {
    authenticatedUserId = null;
    const response = await get();
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ success: false, error: "Unauthorized" });
  });

  test("sends a CSV attachment named after today", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const today = new Date().toISOString().slice(0, 10);
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="gitea-mirror-organizations-${today}.csv"`
    );
  });

  test("writes the header row and no internal fields", async () => {
    const response = await get();
    const csv = await response.text();
    expect(csv.split("\r\n")[0]).toBe(EXPECTED_HEADER);
    expect(ORGANIZATION_EXPORT_COLUMNS).not.toContain("id" as never);
    expect(ORGANIZATION_EXPORT_COLUMNS).not.toContain("userId" as never);
    expect(ORGANIZATION_EXPORT_COLUMNS).not.toContain("configId" as never);
    expect(ORGANIZATION_EXPORT_COLUMNS).not.toContain("sourceId" as never);
    expect(ORGANIZATION_EXPORT_COLUMNS).not.toContain("mirrorOverrides" as never);
  });

  test("writes one row per organization with dates, booleans and counts", async () => {
    seedOrg({ id: "org-acme", name: "acme" });

    const response = await get();
    const csv = await response.text();

    expect(csv.split("\r\n")[1]).toBe(
      [
        "acme",
        "admin",
        "true",
        "mirrors",
        "mirrored",
        "7",
        "5",
        "2",
        "1",
        iso(MIRRORED_AT),
        "",
        iso(CREATED_AT),
        iso(MIRRORED_AT),
      ].join(",")
    );
  });

  test("quotes an error message with commas, quotes and a newline", async () => {
    seedOrg({
      id: "org-acme",
      name: "acme",
      errorMessage: 'Gitea said "no", twice\nand gave up',
    });

    const response = await get();
    const csv = await response.text();
    expect(csv).toContain('"Gitea said ""no"", twice\nand gave up"');
  });

  test("exports only the signed in user's organizations, ordered by name", async () => {
    seedOrg({ id: "org-b", name: "beta" });
    seedOrg({ id: "org-a", name: "Acme" });
    seedOrg({ id: "org-theirs", userId: "user-2", name: "secret-org" });

    const response = await get();
    const csv = await response.text();
    const lines = csv.split("\r\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith("Acme,")).toBe(true);
    expect(lines[2].startsWith("beta,")).toBe(true);
    expect(csv).not.toContain("secret-org");
  });
});
