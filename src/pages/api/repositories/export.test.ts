/**
 * Route tests for GET /api/repositories/export: the auth guard, the header
 * row, RFC 4180 escaping of a description and scoping to the signed in user
 * (#428).
 *
 * Runs against the real schema in an in-memory SQLite database. The route
 * imports @/lib/db, which is replaced with that database through
 * mock.module; bun's mock.module is process-wide and leaks into other test
 * files, so this file registers nothing in the shared process and re-runs
 * itself in an isolated child (same harness as ../organizations/[id]/status.test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const CHILD_FLAG = "GM_REPOSITORIES_EXPORT_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("repositories CSV export route - isolated child suite", () => {
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
  // The seed below only needs the repositories table.
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
const REPOSITORY_EXPORT_COLUMNS = routeModule.REPOSITORY_EXPORT_COLUMNS ?? [];

const EXPECTED_HEADER =
  "name,fullName,url,cloneUrl,owner,organization,sourceProvider,sourceUrl," +
  "destinationProvider,destinationUrl,destinationOrg,mirroredLocation,visibility," +
  "isPrivate,isForked,forkedFrom,isStarred,isArchived,hasLFS,hasSubmodules,hasIssues," +
  "language,description,defaultBranch,size,status,lastMirrored,errorMessage," +
  "importedAt,createdAt,updatedAt";

const IMPORTED_AT = 1_690_000_000;
const MIRRORED_AT = 1_700_000_000;

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function get() {
  return GET({
    params: {},
    request: new Request("http://localhost/api/repositories/export"),
    locals: { session: { userId: "user-1" } },
  } as any);
}

type RepoSeed = {
  id: string;
  userId?: string;
  name: string;
  fullName: string;
  organization?: string | null;
  description?: string | null;
};

function seedRepo({
  id,
  userId = "user-1",
  name,
  fullName,
  organization = null,
  description = null,
}: RepoSeed) {
  const owner = fullName.split("/")[0];
  sqlite.run(
    `INSERT INTO repositories (
       id, user_id, config_id, name, full_name, normalized_full_name, url, clone_url,
       source_provider, source_url, destination_provider, destination_url, destination_org,
       owner, organization, mirrored_location, visibility, is_private, is_fork, forked_from,
       is_starred, is_archived, has_lfs, has_issues, language, description, default_branch,
       size, status, last_mirrored, error_message, imported_at, created_at, updated_at
     ) VALUES (?, ?, 'config-1', ?, ?, ?, ?, ?,
       'github', 'https://github.com', 'gitea', 'https://gitea.example.com', 'mirrors',
       ?, ?, ?, 'public', 0, 0, NULL,
       1, 0, 0, 1, 'TypeScript', ?, 'main',
       128, 'mirrored', ?, NULL, ?, ?, ?)`,
    [
      id,
      userId,
      name,
      fullName,
      fullName.toLowerCase(),
      `https://github.com/${fullName}`,
      `https://github.com/${fullName}.git`,
      owner,
      organization,
      `mirrors/${name}`,
      description,
      MIRRORED_AT,
      IMPORTED_AT,
      IMPORTED_AT,
      MIRRORED_AT,
    ]
  );
}

beforeEach(() => {
  if (!isChild) return;
  authenticatedUserId = "user-1";
  sqlite.run("DELETE FROM repositories");
});

describe.skipIf(!isChild)("GET /api/repositories/export", () => {
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
      `attachment; filename="gitea-mirror-repositories-${today}.csv"`
    );
  });

  test("writes the header row and no internal fields", async () => {
    const response = await get();
    const csv = await response.text();
    expect(csv.split("\r\n")[0]).toBe(EXPECTED_HEADER);
    expect(REPOSITORY_EXPORT_COLUMNS).not.toContain("id" as never);
    expect(REPOSITORY_EXPORT_COLUMNS).not.toContain("userId" as never);
    expect(REPOSITORY_EXPORT_COLUMNS).not.toContain("configId" as never);
    expect(REPOSITORY_EXPORT_COLUMNS).not.toContain("sourceId" as never);
    expect(REPOSITORY_EXPORT_COLUMNS).not.toContain("metadata" as never);
    expect(REPOSITORY_EXPORT_COLUMNS).not.toContain("mirrorOverrides" as never);
  });

  test("writes one row per repository with dates, booleans and blanks", async () => {
    seedRepo({
      id: "repo-1",
      name: "hello-world",
      fullName: "octocat/hello-world",
      description: "A greeting",
    });

    const response = await get();
    const csv = await response.text();

    expect(csv.split("\r\n")[1]).toBe(
      [
        "hello-world",
        "octocat/hello-world",
        "https://github.com/octocat/hello-world",
        "https://github.com/octocat/hello-world.git",
        "octocat",
        "",
        "github",
        "https://github.com",
        "gitea",
        "https://gitea.example.com",
        "mirrors",
        "mirrors/hello-world",
        "public",
        "false",
        "false",
        "",
        "true",
        "false",
        "false",
        "false",
        "true",
        "TypeScript",
        "A greeting",
        "main",
        "128",
        "mirrored",
        iso(MIRRORED_AT),
        "",
        iso(IMPORTED_AT),
        iso(IMPORTED_AT),
        iso(MIRRORED_AT),
      ].join(",")
    );
  });

  test("quotes a description with commas, quotes and a newline", async () => {
    seedRepo({
      id: "repo-1",
      name: "tricky",
      fullName: "octocat/tricky",
      description: 'Uses "quotes", commas\nand a newline',
    });

    const response = await get();
    const csv = await response.text();
    expect(csv).toContain('"Uses ""quotes"", commas\nand a newline"');
  });

  test("exports only the signed in user's repositories, ordered by full name", async () => {
    seedRepo({ id: "repo-b", name: "beta", fullName: "octocat/beta" });
    seedRepo({ id: "repo-a", name: "Alpha", fullName: "octocat/Alpha" });
    seedRepo({
      id: "repo-theirs",
      userId: "user-2",
      name: "secret",
      fullName: "someone/secret",
    });

    const response = await get();
    const csv = await response.text();
    const lines = csv.split("\r\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith("Alpha,octocat/Alpha,")).toBe(true);
    expect(lines[2].startsWith("beta,octocat/beta,")).toBe(true);
    expect(csv).not.toContain("someone/secret");
  });
});
