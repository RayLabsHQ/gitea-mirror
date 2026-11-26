/**
 * Two-factor authentication (#552) end to end: the real Better Auth instance
 * from src/lib/auth.ts, driven over HTTP against an in-memory SQLite database
 * with every migration applied, so the plugin, our schema and the plugin
 * order are tested together. Runs in its own process because it replaces
 * @/lib/db through mock.module.
 */
import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOTP } from "@better-auth/utils/otp";
import * as schema from "@/lib/db/schema";
import { runsIsolated } from "@/tests/isolated";

const isolated = runsIsolated(import.meta.path);

const ORIGIN = "http://localhost:4321";
const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery";

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

if (isolated) {
  process.env.BETTER_AUTH_SECRET = "two-factor-test-secret-0123456789abcdef";
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.ENCRYPTION_SECRET ??= "two-factor-test-encryption-0123456789";
  applyMigrations();
  mock.module("@/lib/db", () => ({ ...schema, db, sqlite }));
}

const { auth } = isolated ? await import("@/lib/auth") : ({} as typeof import("@/lib/auth"));
const { isAuthRedirect } = await import("@/lib/auth-redirect");
const { disableTwoFactorForEmail } = isolated
  ? await import("@/lib/two-factor-admin")
  : ({} as typeof import("@/lib/two-factor-admin"));

/** A browser's cookies: what Set-Cookie gave, minus what it expired. */
class Browser {
  cookies = new Map<string, string>();

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  store(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const expired = !value || attributes.some((a) => /^max-age=0$/i.test(a));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((name) => name.includes(fragment));
  }

  async post(path: string, body: unknown): Promise<{ status: number; data: any }> {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie: this.header() },
        body: JSON.stringify(body),
      }),
    );
    this.store(response);
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  }

  async session(): Promise<any> {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/get-session`, { headers: { origin: ORIGIN, cookie: this.header() } }),
    );
    this.store(response);
    return response.json();
  }
}

/**
 * The secret an authenticator app reads from the QR code. The URI carries it
 * base32 encoded; createOTP takes it decoded, as the server does.
 */
function secretOf(totpURI: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of new URL(totpURI).searchParams.get("secret")!.replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2));
  return String.fromCharCode(...bytes);
}

describe.skipIf(!isolated)("two-factor authentication (#552)", () => {
  // One account goes through the whole life cycle, in order.
  const owner = new Browser();
  let secret = "";
  let backupCodes: string[] = [];

  test("the plugin runs before the OAuth provider, so a password alone never mints an OAuth code", () => {
    const ids = (auth.options.plugins ?? []).map((plugin: { id: string }) => plugin.id);
    expect(ids).toContain("two-factor");
    expect(ids.indexOf("two-factor")).toBeLessThan(ids.indexOf("oauth-provider"));
  });

  test("setting it up: password first, then a code from the app turns it on", async () => {
    expect((await owner.post("/sign-up/email", { email: EMAIL, password: PASSWORD, name: "Owner" })).status).toBe(200);

    const wrongPassword = await owner.post("/two-factor/enable", { password: "nope-nope-nope" });
    expect(wrongPassword.status).toBe(400);

    const enabled = await owner.post("/two-factor/enable", { password: PASSWORD });
    expect(enabled.status).toBe(200);
    expect(enabled.data.totpURI).toStartWith("otpauth://totp/Gitea%20Mirror:owner%40example.com?");
    expect(new URL(enabled.data.totpURI).searchParams.get("issuer")).toBe("Gitea Mirror");
    expect(enabled.data.backupCodes).toHaveLength(10);
    secret = secretOf(enabled.data.totpURI);
    backupCodes = enabled.data.backupCodes;

    // Not on until the first code is entered.
    const [before] = await db.select().from(schema.users).where(eq(schema.users.email, EMAIL));
    expect(before.twoFactorEnabled).toBe(false);
    const [row] = await db.select().from(schema.twoFactors).where(eq(schema.twoFactors.userId, before.id));
    expect(row.verified).toBe(false);
    // Stored encrypted, never as the plain secret.
    expect(row.secret).not.toContain(secret);
    expect(secret).toHaveLength(32);

    const verified = await owner.post("/two-factor/verify-totp", { code: await createOTP(secret).totp() });
    expect(verified.status).toBe(200);
    const [after] = await db.select().from(schema.users).where(eq(schema.users.email, EMAIL));
    expect(after.twoFactorEnabled).toBe(true);
    // Still signed in, and the session says so.
    expect((await owner.session())?.user?.twoFactorEnabled).toBe(true);
  });

  test("a correct password alone gives no session", async () => {
    const browser = new Browser();
    const signIn = await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD });

    expect(signIn.status).toBe(200);
    expect(signIn.data.twoFactorRedirect).toBe(true);
    expect(signIn.data.twoFactorMethods).toEqual(["totp"]);
    expect(browser.has("session_token")).toBe(false);
    expect(await browser.session()).toBeNull();
  });

  test("a wrong code is refused, the right one signs in", async () => {
    const browser = new Browser();
    await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD });

    const wrong = await browser.post("/two-factor/verify-totp", { code: "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.data.code).toBe("INVALID_CODE");
    expect(await browser.session()).toBeNull();

    const right = await browser.post("/two-factor/verify-totp", { code: await createOTP(secret).totp() });
    expect(right.status).toBe(200);
    expect((await browser.session())?.user?.email).toBe(EMAIL);
  });

  test("five wrong codes end the login attempt", async () => {
    const browser = new Browser();
    await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    for (let attempt = 0; attempt < 5; attempt++) {
      await browser.post("/two-factor/verify-totp", { code: "000000" });
    }
    const afterLimit = await browser.post("/two-factor/verify-totp", { code: await createOTP(secret).totp() });
    expect(afterLimit.status).toBe(400);
    expect(afterLimit.data.code).toBe("TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE");
    expect(await browser.session()).toBeNull();

    // A new login starts over (and resets the failure count with a right code).
    const again = new Browser();
    await again.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect((await again.post("/two-factor/verify-totp", { code: await createOTP(secret).totp() })).status).toBe(200);
  });

  test("trusting the device skips the code on the next login from that browser only", async () => {
    const browser = new Browser();
    await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    await browser.post("/two-factor/verify-totp", { code: await createOTP(secret).totp(), trustDevice: true });
    expect(browser.has("trust_device")).toBe(true);
    await browser.post("/sign-out", {});
    expect(await browser.session()).toBeNull();

    const next = await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect(next.data.twoFactorRedirect).toBeUndefined();
    expect((await browser.session())?.user?.email).toBe(EMAIL);

    // Another browser still gets the code step.
    const other = new Browser();
    expect((await other.post("/sign-in/email", { email: EMAIL, password: PASSWORD })).data.twoFactorRedirect).toBe(true);
  });

  test("a backup code signs in once", async () => {
    const first = new Browser();
    await first.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect((await first.post("/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(200);
    expect((await first.session())?.user?.email).toBe(EMAIL);

    const second = new Browser();
    await second.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    const reused = await second.post("/two-factor/verify-backup-code", { code: backupCodes[0] });
    expect(reused.status).toBe(401);
    expect(await second.session()).toBeNull();
  });

  test("new backup codes replace the old ones", async () => {
    const generated = await owner.post("/two-factor/generate-backup-codes", { password: PASSWORD });
    expect(generated.status).toBe(200);
    expect(generated.data.backupCodes).toHaveLength(10);

    const browser = new Browser();
    await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect((await browser.post("/two-factor/verify-backup-code", { code: backupCodes[1] })).status).toBe(401);
    expect((await browser.post("/two-factor/verify-backup-code", { code: generated.data.backupCodes[0] })).status).toBe(200);
  });

  test("an app signing in through Gitea Mirror gets its code only after the second factor", async () => {
    // A public PKCE client that skips consent, so a login goes straight back to it.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, EMAIL));
    sqlite.run(
      `INSERT INTO oauth_clients (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, public, type, require_pkce, skip_consent, user_id, scopes)
       VALUES ('oc-552', 'wiki-552', 'Wiki', '["http://127.0.0.1:4499/cb"]', 'none', '["authorization_code"]', '["code"]', 1, 'native', 1, 1, ?, '["openid","profile","email"]')`,
      [user.id],
    );
    const verifier = "two-factor-pkce-verifier-0123456789abcdefghijk";
    const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "wiki-552",
      redirect_uri: "http://127.0.0.1:4499/cb",
      scope: "openid profile email",
      state: "st-552",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    // No session: the provider sends the browser to the login page with a signed query.
    const browser = new Browser();
    const authorize = await auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${params}`));
    expect(authorize.status).toBe(302);
    const loginUrl = new URL(authorize.headers.get("location")!, ORIGIN);
    expect(loginUrl.pathname).toBe("/login");
    // What the client plugin sends along with every POST from that page.
    const oauthQuery = loginUrl.search.slice(1);

    // The password alone must not hand the app a code, nor make one: with
    // the plugins the other way round a code would be stored and dropped.
    const storedIdentifiers = () =>
      new Set(sqlite.query("SELECT identifier FROM verifications").all().map((row: any) => String(row.identifier)));
    const storedBefore = storedIdentifiers();
    const signIn = await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD, oauth_query: oauthQuery });
    expect(signIn.status).toBe(200);
    expect(signIn.data).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect(isAuthRedirect(signIn.data)).toBe(false);
    expect(browser.has("session_token")).toBe(false);
    const madeBySignIn = [...storedIdentifiers()].filter((identifier) => !storedBefore.has(identifier));
    // Only the two-factor challenge and its attempt counter.
    expect(madeBySignIn.map((identifier) => identifier.replace(/^(2fa-attempts-|2fa-).*/, "$1")).sort()).toEqual([
      "2fa-",
      "2fa-attempts-",
    ]);

    // The code finishes the login and goes back to the app with an authorization code.
    const verified = await browser.post("/two-factor/verify-totp", {
      code: await createOTP(secret).totp(),
      oauth_query: oauthQuery,
    });
    expect(verified.status).toBe(200);
    expect(isAuthRedirect(verified.data)).toBe(true);
    const callback = new URL(verified.data.url);
    expect(`${callback.origin}${callback.pathname}`).toBe("http://127.0.0.1:4499/cb");
    expect(callback.searchParams.get("state")).toBe("st-552");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    // And the code is a real one: the app can trade it for tokens.
    const token = await auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: "http://127.0.0.1:4499/cb",
          client_id: "wiki-552",
          code_verifier: verifier,
        }),
      }),
    );
    expect(token.status).toBe(200);
    expect((await token.json()).access_token).toBeTruthy();
  });

  test("the command line turns it off for a locked-out account and forgets trusted devices", async () => {
    // A trusted browser from before.
    const trusted = new Browser();
    await trusted.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    await trusted.post("/two-factor/verify-totp", { code: await createOTP(secret).totp(), trustDevice: true });

    const result = await disableTwoFactorForEmail(db, ` ${EMAIL.toUpperCase()} `);
    expect(result).toMatchObject({ found: true, wasEnabled: true });
    expect(result.trustedDevicesCleared).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(schema.twoFactors)).toHaveLength(0);

    const browser = new Browser();
    const signIn = await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect(signIn.data.twoFactorRedirect).toBeUndefined();
    expect((await browser.session())?.user?.email).toBe(EMAIL);

    expect(await disableTwoFactorForEmail(db, "nobody@example.com")).toEqual({
      found: false,
      wasEnabled: false,
      trustedDevicesCleared: 0,
    });
    expect((await disableTwoFactorForEmail(db, EMAIL)).wasEnabled).toBe(false);
  });

  test("turning it off from the account needs the password", async () => {
    const browser = new Browser();
    await browser.post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    const enabled = await browser.post("/two-factor/enable", { password: PASSWORD });
    await browser.post("/two-factor/verify-totp", { code: await createOTP(secretOf(enabled.data.totpURI)).totp() });

    expect((await browser.post("/two-factor/disable", { password: "nope-nope-nope" })).status).toBe(400);
    expect((await browser.post("/two-factor/disable", { password: PASSWORD })).status).toBe(200);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, EMAIL));
    expect(user.twoFactorEnabled).toBe(false);
  });
});
