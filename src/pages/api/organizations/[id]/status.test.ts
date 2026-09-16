/**
 * Route tests for PATCH /api/organizations/:id/status with cascade: ignoring
 * an organization ignores its repositories so the scheduler leaves them
 * alone, and including it again restores them (#429).
 *
 * Runs against the real schema in an in-memory SQLite database. The route
 * imports @/lib/db, which is replaced with that database through
 * mock.module; bun's mock.module is process-wide and leaks into other test
 * files, so this file registers nothing in the shared process and re-runs
 * itself in an isolated child (same harness as ../[id].test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const CHILD_FLAG = "GM_ORG_STATUS_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("organization status route (cascade) - isolated child suite", () => {
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

/**
 * Apply every migration in drizzle/ in journal order. The shared test setup
 * stubs drizzle's migrator, so the SQL is run here the way the migrator
 * would: one file per journal entry, statements split on its breakpoint.
 */
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

if (isChild) {
  applyMigrations();
  // The seed below only needs the two tables the route touches.
  sqlite.run("PRAGMA foreign_keys = OFF");

  mock.module("@/lib/auth-guards", () => ({
    requireAuthenticatedUserId: mock(async () => ({ userId: "user-1" })),
  }));

  mock.module("@/lib/db", () => ({ ...schema, db }));
}

const { PATCH } = isChild
  ? await import("./status")
  : { PATCH: undefined as any };

function patch(orgId: string, body: Record<string, unknown>) {
  return PATCH({
    params: { id: orgId },
    request: new Request(`http://localhost/api/organizations/${orgId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: { session: { userId: "user-1" } },
  } as any);
}

type RepoSeed = {
  id: string;
  userId?: string;
  organization: string | null;
  status: string;
  lastMirrored?: number | null;
};

function seedRepo({ id, userId = "user-1", organization, status, lastMirrored = null }: RepoSeed) {
  sqlite.run(
    `INSERT INTO repositories (id, user_id, config_id, name, full_name, normalized_full_name, url, clone_url, owner, organization, default_branch, status, last_mirrored)
     VALUES (?, ?, 'config-1', ?, ?, ?, ?, ?, ?, ?, 'main', ?, ?)`,
    [
      id,
      userId,
      id,
      `${organization ?? "someone"}/${id}`,
      `${organization ?? "someone"}/${id}`.toLowerCase(),
      `https://github.com/${organization ?? "someone"}/${id}`,
      `https://github.com/${organization ?? "someone"}/${id}.git`,
      organization ?? "someone",
      organization,
      status,
      lastMirrored,
    ]
  );
}

function repoStatuses(): Record<string, string> {
  const rows = sqlite.query("SELECT id, status FROM repositories ORDER BY id").all() as { id: string; status: string }[];
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

function orgStatus(id: string): string | undefined {
  const row = sqlite.query("SELECT status FROM organizations WHERE id = ?").get(id) as { status: string } | null;
  return row?.status;
}

beforeEach(() => {
  if (!isChild) return;
  sqlite.run("DELETE FROM repositories");
  sqlite.run("DELETE FROM organizations");
  sqlite.run(
    `INSERT INTO organizations (id, user_id, config_id, name, normalized_name, avatar_url, status)
     VALUES ('org-acme', 'user-1', 'config-1', 'acme', 'acme', '', 'mirrored'),
            ('org-beta', 'user-1', 'config-1', 'beta', 'beta', '', 'mirrored'),
            ('org-theirs', 'user-2', 'config-2', 'acme', 'acme', '', 'mirrored')`
  );
  const mirroredAt = 1_700_000_000;
  seedRepo({ id: "acme-mirrored", organization: "acme", status: "mirrored", lastMirrored: mirroredAt });
  seedRepo({ id: "acme-synced", organization: "acme", status: "synced", lastMirrored: mirroredAt });
  seedRepo({ id: "acme-imported", organization: "acme", status: "imported" });
  seedRepo({ id: "acme-failed", organization: "acme", status: "failed", lastMirrored: mirroredAt });
  seedRepo({ id: "acme-syncing", organization: "acme", status: "syncing", lastMirrored: mirroredAt });
  seedRepo({ id: "acme-mirroring", organization: "acme", status: "mirroring" });
  seedRepo({ id: "acme-deleting", organization: "acme", status: "deleting", lastMirrored: mirroredAt });
  seedRepo({ id: "acme-ignored-before", organization: "acme", status: "ignored" });
  seedRepo({ id: "beta-mirrored", organization: "beta", status: "mirrored", lastMirrored: mirroredAt });
  seedRepo({ id: "personal-mirrored", organization: null, status: "mirrored", lastMirrored: mirroredAt });
  seedRepo({ id: "theirs-acme-mirrored", userId: "user-2", organization: "acme", status: "mirrored", lastMirrored: mirroredAt });
});

describe.skipIf(!isChild)("PATCH /api/organizations/:id/status", () => {
  test("ignoring with cascade ignores the organization's idle repositories only", async () => {
    const response = await patch("org-acme", { status: "ignored", cascade: true });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.repositoriesChanged).toBe(4);
    expect(orgStatus("org-acme")).toBe("ignored");

    expect(repoStatuses()).toEqual({
      "acme-mirrored": "ignored",
      "acme-synced": "ignored",
      "acme-imported": "ignored",
      "acme-failed": "ignored",
      // In flight and on the way out: left to finish on their own.
      "acme-syncing": "syncing",
      "acme-mirroring": "mirroring",
      "acme-deleting": "deleting",
      "acme-ignored-before": "ignored",
      // Other organization, personal repository, other user: untouched.
      "beta-mirrored": "mirrored",
      "personal-mirrored": "mirrored",
      "theirs-acme-mirrored": "mirrored",
    });
  });

  test("including with cascade restores mirrored repositories as mirrored and the rest as imported", async () => {
    await patch("org-acme", { status: "ignored", cascade: true });
    const response = await patch("org-acme", { status: "imported", cascade: true });
    expect(response.status).toBe(200);
    const data = await response.json();
    // The four the ignore touched plus the one ignored beforehand.
    expect(data.repositoriesChanged).toBe(5);
    expect(orgStatus("org-acme")).toBe("imported");

    const statuses = repoStatuses();
    expect(statuses["acme-mirrored"]).toBe("mirrored");
    expect(statuses["acme-synced"]).toBe("mirrored");
    expect(statuses["acme-failed"]).toBe("mirrored");
    expect(statuses["acme-imported"]).toBe("imported");
    expect(statuses["acme-ignored-before"]).toBe("imported");
    expect(statuses["beta-mirrored"]).toBe("mirrored");
    expect(statuses["theirs-acme-mirrored"]).toBe("mirrored");
  });

  test("without cascade only the organization changes", async () => {
    const response = await patch("org-acme", { status: "ignored" });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.repositoriesChanged).toBe(0);
    expect(orgStatus("org-acme")).toBe("ignored");
    expect(repoStatuses()["acme-mirrored"]).toBe("mirrored");
  });

  test("a status other than ignored or imported never touches repositories", async () => {
    const response = await patch("org-acme", { status: "failed", cascade: true });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.repositoriesChanged).toBe(0);
    expect(repoStatuses()["acme-mirrored"]).toBe("mirrored");
  });

  test("answers 404 for another user's organization and changes nothing", async () => {
    const response = await patch("org-theirs", { status: "ignored", cascade: true });
    expect(response.status).toBe(404);
    expect(orgStatus("org-theirs")).toBe("mirrored");
    expect(repoStatuses()["theirs-acme-mirrored"]).toBe("mirrored");
  });

  test("rejects an unknown status", async () => {
    const response = await patch("org-acme", { status: "paused", cascade: true });
    expect(response.status).toBe(400);
    expect(orgStatus("org-acme")).toBe("mirrored");
  });
});
