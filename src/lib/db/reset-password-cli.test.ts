import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyPassword } from "better-auth/crypto";

const root = resolve(import.meta.dir, "../../..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "gitea-mirror-reset-password-"));
const bundle = join(temporaryRoot, "manage-db.js");
afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function run(cmd: string[], cwd: string) {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
  return Buffer.from(result.stdout).toString();
}

run([process.execPath, "build", "scripts/manage-db.ts", "--target=bun", `--outfile=${bundle}`], root);

for (const bundled of [false, true]) {
  for (const existingCredential of [false, true]) {
    test(`reset-password (${bundled ? "bundled" : "source"}, ${existingCredential ? "existing" : "new"} credential)`, async () => {
      const cwd = mkdtempSync(join(temporaryRoot, "case-"));
      mkdirSync(join(cwd, "data"));
      const db = new Database(join(cwd, "data/gitea-mirror.db"));
      try {
        db.exec(`
          CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL UNIQUE,
            email_verified INTEGER DEFAULT 0, image TEXT, created_at INTEGER DEFAULT 0,
            updated_at INTEGER DEFAULT 0, username TEXT);
          CREATE TABLE accounts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
            user_id TEXT NOT NULL, provider_id TEXT NOT NULL, issuer TEXT DEFAULT '',
            provider_user_id TEXT, access_token TEXT, refresh_token TEXT, id_token TEXT,
            access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT,
            expires_at INTEGER, password TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
          CREATE TABLE sessions (id TEXT PRIMARY KEY, token TEXT NOT NULL, user_id TEXT NOT NULL,
            expires_at INTEGER, ip_address TEXT, user_agent TEXT, created_at INTEGER DEFAULT 0,
            updated_at INTEGER DEFAULT 0);
          INSERT INTO users (id, email) VALUES ('target', 'admin@example.com'), ('other', 'other@example.com');
          INSERT INTO accounts (id, account_id, user_id, provider_id, password)
            VALUES ('oauth', 'remote', 'target', 'github', NULL), ('other-account', 'other', 'other', 'credential', 'unchanged');
          INSERT INTO sessions (id, token, user_id) VALUES ('one', 'one', 'target'), ('two', 'two', 'target'), ('other', 'other', 'other');
        `);
        if (existingCredential) {
          db.exec("INSERT INTO accounts (id, account_id, user_id, provider_id, password) VALUES ('credential', 'target', 'target', 'credential', 'old')");
        }
        const output = run([process.execPath, bundled ? bundle : join(root, "scripts/manage-db.ts"),
          "reset-password", "--email=admin@example.com", "--new-password=new-secure-password"], cwd);
        expect(output).toContain("Password reset for admin@example.com");
        expect(output).toContain("Cleared 2 active session(s)");
        const credentials = db.query("SELECT * FROM accounts WHERE user_id = 'target' AND provider_id = 'credential'").all() as Array<{ password: string; issuer: string }>;
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
    }, 15000);
  }
}
