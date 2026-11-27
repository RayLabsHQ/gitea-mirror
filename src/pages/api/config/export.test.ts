/**
 * GET /api/config/export (#587): the settings file. Checks that no credential
 * or run state reaches it, that sources, organizations and repositories come
 * out in a stable order with their choices, and that two exports of the same
 * settings are byte for byte the same.
 *
 * Runs against the real schema in an in-memory SQLite database that replaces
 * @/lib/db through mock.module, so the file re-runs itself in an isolated
 * child (same harness as ../organizations/export.test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const CHILD_FLAG = "GM_SETTINGS_EXPORT_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("settings export route - isolated child suite", () => {
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

let authenticatedUserId: string | null = "user-1";

if (isChild) {
  process.env.ENCRYPTION_SECRET ??= "settings-export-test-secret-0123456789";
  applyMigrations();
  sqlite.run("PRAGMA foreign_keys = OFF");
  mock.module("@/lib/auth-guards", () => ({
    requireAuthenticatedUserId: mock(async () =>
      authenticatedUserId
        ? { userId: authenticatedUserId }
        : {
            response: new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
          }
    ),
  }));
  mock.module("@/lib/db", () => ({ ...schema, db }));
}

const { GET } = isChild
  ? await import("./export")
  : ({} as Partial<typeof import("./export")>);
const { encrypt } = isChild
  ? await import("@/lib/utils/encryption")
  : ({} as Partial<typeof import("@/lib/utils/encryption")>);

/** Every value here is a credential: none may appear in the file. */
const SECRETS = [
  "ghp_personal_token_value",
  "gitea_destination_token",
  "ntfy_access_token",
  "gotify_app_token",
  "webhook_signing_secret",
  "hooks.slack.com/services/T000/B000/XXXX",
  "basic-auth-password",
  "-----BEGIN PRIVATE KEY-----",
  "gitlab_token_value",
];

function get(query = "") {
  return GET!({
    params: {},
    request: new Request(`http://localhost/api/config/export${query}`),
    locals: {},
  } as any);
}

async function seed() {
  await db.insert(schema.configs).values({
    id: "config-1",
    userId: "user-1",
    name: "Default",
    isActive: true,
    githubConfig: {
      owner: "octo",
      token: "ghp_personal_token_value",
      includeStarred: true,
      mirrorStrategy: "single-org",
    } as any,
    giteaConfig: {
      url: "https://admin:basic-auth-password@gitea.example.com",
      token: "gitea_destination_token",
      defaultOwner: "mirror",
      releaseLimit: 25,
    } as any,
    include: ["*"],
    exclude: ["octo/scratch"],
    scheduleConfig: { enabled: true, interval: "0 22 * * *", lastRun: new Date("2026-11-26T22:00:00Z"), nextRun: new Date("2026-11-27T22:00:00Z") } as any,
    cleanupConfig: { enabled: true, orphanedRepoAction: "archive", lastRun: new Date("2026-11-26T00:00:00Z"), nextRun: new Date("2026-11-27T00:00:00Z") } as any,
    notificationConfig: {
      enabled: true,
      provider: "webhook",
      ntfy: { url: "https://ntfy.sh", topic: "mirror", token: "ntfy_access_token" },
      gotify: { url: "https://gotify.example.com", token: "gotify_app_token" },
      webhook: { url: "https://hooks.slack.com/services/T000/B000/XXXX", secret: "webhook_signing_secret" },
    } as any,
  });

  const appCredential = `github-app:v1:${JSON.stringify({
    appId: "1",
    installationId: "2",
    privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  })}`;
  await db.insert(schema.sources).values([
    { id: "src-gh", userId: "user-1", name: "GitHub", provider: "github", url: "https://github.com", username: "octo", token: encrypt!("ghp_personal_token_value") },
    { id: "src-app", userId: "user-1", name: "Work app", provider: "github", url: "https://github.com", username: "work", token: encrypt!(appCredential) },
    { id: "src-pub", userId: "user-1", name: "Codeberg", provider: "gitea", url: "https://codeberg.org", username: "", token: null },
    { id: "src-gl", userId: "user-1", name: "GitLab", provider: "gitlab", url: "https://gitlab.com", username: "octo", token: encrypt!("gitlab_token_value"), enabled: false },
  ] as any);

  await db.insert(schema.organizations).values([
    { id: "org-1", userId: "user-1", configId: "config-1", sourceId: "src-gh", name: "zeta", normalizedName: "zeta", avatarUrl: "", isIncluded: true, status: "mirrored", destinationOrg: "zeta-mirrors", mirrorOverrides: { releaseLimit: 5, mirrorIssues: false } },
    { id: "org-2", userId: "user-1", configId: "config-1", sourceId: "src-gh", name: "Alpha", normalizedName: "alpha", avatarUrl: "", isIncluded: false, status: "ignored" },
    { id: "org-3", userId: "user-1", configId: "config-1", sourceId: "src-pub", name: "forgejo", normalizedName: "forgejo", avatarUrl: "", isIncluded: true, status: "imported", errorMessage: "boom" },
  ] as any);

  const repo = (id: string, fullName: string, sourceId: string, extra: Record<string, unknown> = {}) => ({
    id,
    userId: "user-1",
    configId: "config-1",
    sourceId,
    name: fullName.split("/")[1],
    fullName,
    normalizedFullName: fullName.toLowerCase(),
    url: `https://example.com/${fullName}`,
    cloneUrl: `https://example.com/${fullName}.git`,
    owner: fullName.split("/")[0],
    defaultBranch: "main",
    status: "mirrored",
    errorMessage: "last sync failed",
    ...extra,
  });
  await db.insert(schema.repositories).values([
    repo("r1", "octo/plain", "src-gh"),
    repo("r2", "octo/skipped", "src-gh", { status: "ignored" }),
    repo("r3", "octo/elsewhere", "src-gh", { destinationOrg: "archive" }),
    repo("r4", "forgejo/runner", "src-pub", { mirrorOverrides: { releaseAssetLimit: 0, releaseLimit: null } }),
  ] as any);
}

beforeEach(async () => {
  if (!isChild) return;
  authenticatedUserId = "user-1";
  for (const table of ["repositories", "organizations", "sources", "configs"]) sqlite.run(`DELETE FROM ${table}`);
});

describe.skipIf(!isChild)("GET /api/config/export (#587)", () => {
  test("answers 401 without a session or API key", async () => {
    authenticatedUserId = null;
    expect((await get()).status).toBe(401);
  });

  test("answers 404 before there are any settings", async () => {
    const response = await get();
    expect(response.status).toBe(404);
  });

  test("sends a JSON attachment named after today", async () => {
    await seed();
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="gitea-mirror-settings-${new Date().toISOString().slice(0, 10)}.json"`
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("leaves out every credential, run time and per instance field", async () => {
    await seed();
    const text = await (await get("?repositories=all")).text();
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    for (const field of ["lastRun", "nextRun", "errorMessage", "\"id\"", "userId", "configId", "sourceId", "createdAt", "updatedAt"]) {
      expect(text).not.toContain(field);
    }
    const file = JSON.parse(text);
    expect(file.settings.giteaConfig.url).toBe("https://gitea.example.com");
    expect(file.settings.notificationConfig.ntfy).toEqual({ topic: "mirror", url: "https://ntfy.sh" });
    expect(file.settings.notificationConfig.webhook).toEqual({});
    expect(file.settings.scheduleConfig).toEqual({ enabled: true, interval: "0 22 * * *" });
    expect(file.settings.exclude).toEqual(["octo/scratch"]);
  });

  test("lists sources by a stable reference, saying how each logs in", async () => {
    await seed();
    const file = await (await get()).json();
    expect(file.format).toBe("gitea-mirror-settings");
    expect(file.version).toBe(1);
    expect(file.sources).toEqual([
      { authentication: "none", enabled: true, name: "Codeberg", provider: "gitea", reference: "gitea https://codeberg.org", url: "https://codeberg.org", username: null },
      { authentication: "token", enabled: true, name: "GitHub", provider: "github", reference: "github https://github.com octo", url: "https://github.com", username: "octo" },
      { authentication: "github-app", enabled: true, name: "Work app", provider: "github", reference: "github https://github.com work", url: "https://github.com", username: "work" },
      { authentication: "token", enabled: false, name: "GitLab", provider: "gitlab", reference: "gitlab https://gitlab.com octo", url: "https://gitlab.com", username: "octo" },
    ]);
  });

  test("keeps the choices made on organizations and repositories", async () => {
    await seed();
    const file = await (await get()).json();
    expect(file.organizations).toEqual([
      { included: true, name: "forgejo", source: "gitea https://codeberg.org" },
      { ignored: true, included: false, name: "Alpha", source: "github https://github.com octo" },
      {
        destinationOrg: "zeta-mirrors",
        included: true,
        mirrorOverrides: { mirrorIssues: false, releaseLimit: 5 },
        name: "zeta",
        source: "github https://github.com octo",
      },
    ]);
    // By default only repositories with a choice of their own.
    expect(file.repositoryList).toBe("with-choices");
    expect(file.repositories).toEqual([
      { fullName: "forgejo/runner", mirrorOverrides: { releaseAssetLimit: 0 }, source: "gitea https://codeberg.org" },
      { destinationOrg: "archive", fullName: "octo/elsewhere", source: "github https://github.com octo" },
      { fullName: "octo/skipped", ignored: true, source: "github https://github.com octo" },
    ]);
  });

  test("?repositories=all lists every tracked repository", async () => {
    await seed();
    const file = await (await get("?repositories=all")).json();
    expect(file.repositoryList).toBe("all");
    expect(file.repositories.map((r: any) => r.fullName)).toEqual([
      "forgejo/runner",
      "octo/elsewhere",
      "octo/plain",
      "octo/skipped",
    ]);
  });

  test("two exports of the same settings are identical, with sorted keys", async () => {
    await seed();
    const first = await (await get()).text();
    const second = await (await get()).text();
    expect(second).toBe(first);
    expect(first.endsWith("}\n")).toBe(true);
    const file = JSON.parse(first);
    const keys = Object.keys(file.settings.giteaConfig);
    expect(keys).toEqual([...keys].sort());
  });
});
