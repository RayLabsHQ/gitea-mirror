/**
 * Regression test for the password reset CLI (#461).
 *
 * `manage-db reset-password` used a Drizzle client without a schema, so
 * `db.query.users` was undefined and every reset failed. Each case builds a
 * real database with `manage-db init` (the migrations in drizzle/), seeds it,
 * runs the reset through the source script and through the bundle the Docker
 * image ships, and checks the result with Better Auth.
 *
 * Other test files replace bun:sqlite with mock.module, which is process wide
 * in bun and depends on file order, so the suite runs in an isolated child
 * process (same harness as gitea-incremental-metadata.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHILD_FLAG = "GM_RESET_PASSWORD_CLI_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("reset-password CLI - isolated child suite", () => {
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

const root = resolve(import.meta.dir, "../../..");
let temporaryRoot = "";
let bundle = "";

function run(cmd: string[], cwd: string) {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
  return Buffer.from(result.stdout).toString();
}

describe.skipIf(!isChild)("manage-db reset-password", () => {
  beforeAll(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "gitea-mirror-reset-password-"));
    bundle = join(temporaryRoot, "manage-db.js");
    run([process.execPath, "build", "scripts/manage-db.ts", "--target=bun", `--outfile=${bundle}`], root);
  });
  afterAll(() => {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  });

  for (const bundled of [false, true]) {
    for (const existingCredential of [false, true]) {
      test(`${bundled ? "bundled" : "source"} script, ${existingCredential ? "existing" : "new"} credential`, async () => {
        const { Database } = await import("bun:sqlite");
        const { verifyPassword } = await import("better-auth/crypto");
        const script = bundled ? bundle : join(root, "scripts/manage-db.ts");

        // A real schema: init runs the migrations from ./drizzle.
        const cwd = mkdtempSync(join(temporaryRoot, "case-"));
        symlinkSync(join(root, "drizzle"), join(cwd, "drizzle"));
        run([process.execPath, script, "init"], cwd);

        const db = new Database(join(cwd, "data/gitea-mirror.db"));
        try {
          db.exec(`
            INSERT INTO users (id, name, email) VALUES ('target', 'Target', 'admin@example.com'), ('other', 'Other', 'other@example.com');
            INSERT INTO accounts (id, account_id, user_id, provider_id, password)
              VALUES ('oauth', 'remote', 'target', 'github', NULL), ('other-account', 'other', 'other', 'credential', 'unchanged');
            INSERT INTO sessions (id, token, user_id, expires_at) VALUES ('one', 'one', 'target', 0), ('two', 'two', 'target', 0), ('other', 'other', 'other', 0);
          `);
          if (existingCredential) {
            db.exec("INSERT INTO accounts (id, account_id, user_id, provider_id, password) VALUES ('credential', 'target', 'target', 'credential', 'old')");
          }

          const output = run(
            [process.execPath, script, "reset-password", "--email=admin@example.com", "--new-password=new-secure-password"],
            cwd
          );
          expect(output).toContain("Password reset for admin@example.com");
          expect(output).toContain("Cleared 2 active session(s)");

          const credentials = db
            .query("SELECT * FROM accounts WHERE user_id = 'target' AND provider_id = 'credential'")
            .all() as Array<{ password: string; issuer: string }>;
          expect(credentials).toHaveLength(1);
          expect(await verifyPassword({ hash: credentials[0].password, password: "new-secure-password" })).toBe(true);
          if (!existingCredential) expect(credentials[0].issuer).toBe("local:credential");
          expect(db.query("SELECT id FROM sessions").all()).toEqual([{ id: "other" }]);
          expect(db.query("SELECT password FROM accounts WHERE id = 'other-account'").get()).toEqual({ password: "unchanged" });
          expect(db.query("SELECT password FROM accounts WHERE id = 'oauth'").get()).toEqual({ password: null });
          expect(db.query("SELECT id FROM users").all()).toHaveLength(2);
        } finally {
          db.close();
        }
      }, 15_000);
    }
  }
});
