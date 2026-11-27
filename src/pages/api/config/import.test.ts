/**
 * POST /api/config/import (#587): reading an export back. The round trip the
 * issue asked for is here: export one instance, import into a fresh one,
 * enter the tokens, export again, and the two files match.
 *
 * Runs against the real schema in an in-memory SQLite database that replaces
 * @/lib/db through mock.module, so the file re-runs itself in an isolated
 * child (same harness as ./export.test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

const CHILD_FLAG = "GM_SETTINGS_IMPORT_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("settings import route - isolated child suite", () => {
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
  process.env.ENCRYPTION_SECRET ??= "settings-import-test-secret-0123456789";
  for (const name of ["GITHUB_TOKEN", "GITHUB_USERNAME", "GITEA_URL", "GITEA_TOKEN", "GITEA_USERNAME", "SCHEDULE_ENABLED", "SCHEDULE_INTERVAL", "GITEA_MIRROR_INTERVAL", "CLEANUP_ENABLED"]) {
    delete process.env[name];
  }
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
  // No DNS in tests: the guard refuses the cloud metadata address only.
  mock.module("@/lib/utils/outbound-url", () => ({
    blockedOutboundUrlReason: mock(async (url: string) =>
      url.includes("169.254.169.254") ? "Link-local addresses are not allowed." : null
    ),
  }));
}

const { POST } = isChild ? await import("./import") : ({} as Partial<typeof import("./import")>);
const { GET } = isChild ? await import("./export") : ({} as Partial<typeof import("./export")>);
const { encrypt, decrypt } = isChild
  ? await import("@/lib/utils/encryption")
  : ({} as Partial<typeof import("@/lib/utils/encryption")>);
const { createDefaultConfig } = isChild
  ? await import("@/lib/utils/config-defaults")
  : ({} as Partial<typeof import("@/lib/utils/config-defaults")>);

async function exportText(userId: string): Promise<string> {
  authenticatedUserId = userId;
  const response = await GET!({
    params: {},
    request: new Request("http://localhost/api/config/export"),
    locals: {},
  } as any);
  expect(response.status).toBe(200);
  return response.text();
}

async function importFile(userId: string, file: unknown, extra: Record<string, unknown> = {}) {
  authenticatedUserId = userId;
  const response = await POST!({
    params: {},
    request: new Request("http://localhost/api/config/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, ...extra }),
    }),
    locals: {},
  } as any);
  return { status: response.status, body: (await response.json()) as any };
}

async function configOf(userId: string) {
  const [row] = await db.select().from(schema.configs).where(eq(schema.configs.userId, userId));
  return row as any;
}

async function sourcesOf(userId: string) {
  const rows = await db.select().from(schema.sources).where(eq(schema.sources.userId, userId));
  return rows.sort((a, b) => +a.createdAt - +b.createdAt);
}

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);

/** The instance being backed up, built on the same defaults a new one gets. */
async function seedSourceInstance() {
  await createDefaultConfig!({ userId: "user-1" });
  const config = await configOf("user-1");
  await db
    .update(schema.configs)
    .set({
      githubConfig: { ...config.githubConfig, includeStarred: true, mirrorStrategy: "single-org", starredLists: ["tools"] },
      giteaConfig: {
        ...config.giteaConfig,
        url: "https://admin:basic-auth-password@gitea.example.com",
        token: encrypt!("gitea_destination_token"),
        defaultOwner: "mirror",
        releaseLimit: 25,
        prereleaseAssetLimit: 2,
      },
      include: ["*"],
      exclude: ["octo/scratch"],
      scheduleConfig: { ...config.scheduleConfig, enabled: true, interval: "0 22 * * *", timezone: "Europe/Berlin" },
      notificationConfig: {
        ...config.notificationConfig,
        enabled: true,
        provider: "ntfy",
        ntfy: { url: "https://ntfy.example.com", topic: "mirror", token: encrypt!("ntfy_access_token") },
        webhook: { url: "https://hooks.slack.com/services/T000/B000/XXXX", secret: encrypt!("webhook_signing_secret") },
      },
    } as any)
    .where(eq(schema.configs.userId, "user-1"));

  await db.insert(schema.sources).values([
    { id: "a-gh", userId: "user-1", name: "GitHub", provider: "github", url: "https://github.com", username: "octo", token: encrypt!("ghp_token"), createdAt: at(1) },
    { id: "a-pub", userId: "user-1", name: "Codeberg", provider: "gitea", url: "https://codeberg.org", username: "", token: null, createdAt: at(2) },
    { id: "a-gl", userId: "user-1", name: "Work GitLab", provider: "gitlab", url: "https://gitlab.example.com", username: "octo", token: encrypt!("gitlab_token"), enabled: false, createdAt: at(3) },
  ] as any);

  const configId = (await configOf("user-1")).id;
  await db.insert(schema.organizations).values([
    org("user-1", configId, "a-gh", "zeta", { status: "mirrored", destinationOrg: "zeta-mirrors", mirrorOverrides: { releaseLimit: 5, mirrorIssues: false } }),
    org("user-1", configId, "a-gh", "Alpha", { isIncluded: false, status: "ignored" }),
    org("user-1", configId, "a-pub", "forgejo"),
  ] as any);
  await db.insert(schema.repositories).values([
    repo("user-1", configId, "a-gh", "octo/plain"),
    repo("user-1", configId, "a-gh", "octo/skipped", { status: "ignored" }),
    repo("user-1", configId, "a-gh", "octo/elsewhere", { destinationOrg: "archive" }),
    repo("user-1", configId, "a-pub", "forgejo/runner", { mirrorOverrides: { releaseAssetLimit: 0 } }),
  ] as any);
}

function org(userId: string, configId: string, sourceId: string | null, name: string, extra: Record<string, unknown> = {}) {
  return {
    id: `${userId}-org-${name}`,
    userId,
    configId,
    sourceId,
    name,
    normalizedName: name.toLowerCase(),
    avatarUrl: "",
    isIncluded: true,
    status: "imported",
    ...extra,
  };
}

function repo(userId: string, configId: string, sourceId: string | null, fullName: string, extra: Record<string, unknown> = {}) {
  return {
    id: `${userId}-repo-${fullName}`,
    userId,
    configId,
    sourceId,
    name: fullName.split("/")[1],
    fullName,
    normalizedFullName: fullName.toLowerCase(),
    url: `https://example.com/${fullName}`,
    cloneUrl: `https://example.com/${fullName}.git`,
    owner: fullName.split("/")[0],
    defaultBranch: "main",
    status: "mirrored",
    lastMirrored: at(10),
    ...extra,
  };
}

/** What "Import repositories" leaves behind on the new instance: rows without choices. */
async function discover(userId: string) {
  const configId = (await configOf(userId)).id;
  const ids = Object.fromEntries((await sourcesOf(userId)).map((s) => [s.provider, s.id]));
  await db.insert(schema.organizations).values([
    org(userId, configId, ids.github, "zeta"),
    org(userId, configId, ids.github, "Alpha"),
    org(userId, configId, ids.gitea, "forgejo"),
  ] as any);
  await db.insert(schema.repositories).values([
    repo(userId, configId, ids.github, "octo/plain", { status: "imported", lastMirrored: null }),
    repo(userId, configId, ids.github, "octo/skipped", { status: "imported", lastMirrored: null }),
    repo(userId, configId, ids.github, "octo/elsewhere", { status: "imported", lastMirrored: null }),
    repo(userId, configId, ids.gitea, "forgejo/runner", { status: "imported", lastMirrored: null }),
  ] as any);
}

beforeEach(async () => {
  if (!isChild) return;
  authenticatedUserId = "user-1";
  for (const table of ["repositories", "organizations", "sources", "configs"]) sqlite.run(`DELETE FROM ${table}`);
});

describe.skipIf(!isChild)("POST /api/config/import (#587)", () => {
  test("answers 401 without a session or API key", async () => {
    authenticatedUserId = null;
    const response = await POST!({
      params: {},
      request: new Request("http://localhost/api/config/import", { method: "POST", body: "{}" }),
      locals: {},
    } as any);
    expect(response.status).toBe(401);
  });

  test("refuses anything that is not a settings file, or one from a newer version", async () => {
    expect((await importFile("user-1", { hello: "world" })).body.message).toBe("This is not a Gitea Mirror settings file.");
    const newer = await importFile("user-1", { format: "gitea-mirror-settings", version: 99 });
    expect(newer.status).toBe(400);
    expect(newer.body.message).toContain("newer version");
    const text = await importFile("user-1", "{ not json");
    expect(text.status).toBe(400);
  });

  test("round trip: export, import into a fresh instance, enter the tokens, export again, same file", async () => {
    await seedSourceInstance();
    const original = await exportText("user-1");

    // First import: settings and sources; the organizations and repositories
    // are not on the new instance yet.
    const first = await importFile("user-2", JSON.parse(original), { apply: true });
    expect(first.status).toBe(200);
    expect(first.body.applied).toBe(true);
    expect(first.body.summary.sources.added.map((s: any) => [s.name, s.enabled])).toEqual([
      ["GitHub", false],
      ["Codeberg", true],
      ["Work GitLab", false],
    ]);
    expect(first.body.summary.organizations.notFound).toHaveLength(3);
    expect(first.body.summary.repositories.notFound).toHaveLength(3);
    expect(first.body.summary.todo.join("\n")).toContain("Enter the token for the source GitHub on the Connections tab, then turn it on.");
    expect(first.body.summary.todo.join("\n")).toContain("Import the repositories from your sources, then import this file again");

    // Import the repositories, then the same file again.
    await discover("user-2");
    const second = await importFile("user-2", JSON.parse(original), { apply: true });
    expect(second.status).toBe(200);
    expect(second.body.summary.sources.added).toEqual([]);
    expect(second.body.summary.settings).toEqual([]);
    expect(second.body.summary.organizations.notFound).toEqual([]);
    expect(second.body.summary.repositories.notFound).toEqual([]);
    expect(second.body.summary.organizations.updated.map((o: any) => o.name).sort()).toEqual(["Alpha", "zeta"]);

    // The user enters the tokens and turns GitHub back on.
    const [gh, , gl] = await sourcesOf("user-2");
    await db.update(schema.sources).set({ token: encrypt!("new_gh"), enabled: true }).where(eq(schema.sources.id, gh.id));
    await db.update(schema.sources).set({ token: encrypt!("new_gl") }).where(eq(schema.sources.id, gl.id));

    expect(await exportText("user-2")).toBe(original);

    // And a third import finds nothing left to do.
    const third = await importFile("user-2", JSON.parse(original));
    expect(third.body.summary.settings).toEqual([]);
    expect(third.body.summary.sources.updated).toEqual([]);
    expect(third.body.summary.organizations.updated).toEqual([]);
    expect(third.body.summary.repositories.updated).toEqual([]);
  });

  test("a preview changes nothing", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    const preview = await importFile("user-2", file);
    expect(preview.status).toBe(200);
    expect(preview.body.applied).toBe(false);
    expect(preview.body.summary.settings).toContain("giteaConfig.releaseLimit");
    expect(preview.body.summary.sources.added).toHaveLength(3);
    expect(await configOf("user-2")).toBeUndefined();
    expect(await sourcesOf("user-2")).toEqual([]);
  });

  test("importing into the same instance keeps every saved token and the URL credentials", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    const before = await configOf("user-1");
    const result = await importFile("user-1", file, { apply: true });
    expect(result.body.summary.settings).toEqual([]);
    expect(result.body.summary.todo).toEqual([]);
    const after = await configOf("user-1");
    expect(after.giteaConfig.url).toBe("https://admin:basic-auth-password@gitea.example.com");
    expect(decrypt!(after.giteaConfig.token)).toBe("gitea_destination_token");
    expect(decrypt!(after.notificationConfig.ntfy.token)).toBe("ntfy_access_token");
    expect(after.notificationConfig.webhook.url).toBe(before.notificationConfig.webhook.url);
    expect(decrypt!(after.notificationConfig.webhook.secret)).toBe("webhook_signing_secret");
    for (const source of await sourcesOf("user-1")) {
      if (source.provider !== "gitea") expect(source.token).toBeTruthy();
    }
  });

  test("a token tied to an address that moves is dropped and listed to enter again", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    file.settings.giteaConfig.url = "https://forgejo.example.net";
    file.settings.notificationConfig.ntfy.url = "https://ntfy.sh";
    // Nothing mirrored, so the destination is not locked.
    await db.update(schema.repositories).set({ status: "imported" });
    const result = await importFile("user-1", file, { apply: true });
    expect(result.status).toBe(200);
    expect(result.body.summary.settings).toEqual(
      expect.arrayContaining(["giteaConfig.url", "notificationConfig.ntfy.url"])
    );
    expect(result.body.summary.todo.join("\n")).toContain("Enter a destination token for https://forgejo.example.net");
    expect(result.body.summary.todo.join("\n")).toContain("Enter the ntfy access token again");
    const after = await configOf("user-1");
    expect(after.giteaConfig.url).toBe("https://forgejo.example.net");
    expect(after.giteaConfig.token).toBe("");
    expect(after.notificationConfig.ntfy.token).toBe("");
  });

  test("a locked destination only moves with confirmation", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    file.settings.giteaConfig.url = "https://forgejo.example.net";
    file.settings.giteaConfig.releaseLimit = 3;

    const preview = await importFile("user-1", file);
    expect(preview.status).toBe(200);
    expect(preview.body.summary.destinationLock).toContain("The destination is locked");

    const refused = await importFile("user-1", file, { apply: true });
    expect(refused.status).toBe(409);
    expect(refused.body.lock).toBe("destination");
    expect((await configOf("user-1")).giteaConfig.releaseLimit).toBe(25);

    const confirmed = await importFile("user-1", file, { apply: true, confirmDestinationChange: true });
    expect(confirmed.status).toBe(200);
    expect((await configOf("user-1")).giteaConfig.url).toBe("https://forgejo.example.net");
    expect((await configOf("user-1")).giteaConfig.releaseLimit).toBe(3);
  });

  test("refuses blocked addresses and invalid values, changing nothing", async () => {
    await seedSourceInstance();
    const original = JSON.parse(await exportText("user-1"));

    const blockedDestination = structuredClone(original);
    blockedDestination.settings.giteaConfig.url = "http://169.254.169.254";
    const a = await importFile("user-2", blockedDestination, { apply: true });
    expect(a.status).toBe(400);
    expect(a.body.message).toContain("destination address");

    const blockedSource = structuredClone(original);
    blockedSource.sources.push({ provider: "gitea", url: "http://169.254.169.254", name: "Metadata" });
    const b = await importFile("user-2", blockedSource, { apply: true });
    expect(b.status).toBe(400);
    expect(b.body.message).toContain("Metadata");

    const invalid = structuredClone(original);
    invalid.settings.giteaConfig.releaseLimit = "lots";
    const c = await importFile("user-2", invalid, { apply: true });
    expect(c.status).toBe(400);
    expect(c.body.details.join("\n")).toContain("giteaConfig.releaseLimit");

    expect(await configOf("user-2")).toBeUndefined();
    expect(await sourcesOf("user-2")).toEqual([]);
  });

  test("never imports credentials or unknown keys from a hand edited file", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    file.settings.giteaConfig.token = "planted_token";
    file.settings.giteaConfig.somethingNew = true;
    file.settings.notificationConfig.webhook.url = "https://attacker.example.com/hook";
    file.settings.extraSection = {};
    const result = await importFile("user-1", file, { apply: true });
    expect(result.status).toBe(200);
    expect(result.body.summary.skipped.join("\n")).toContain("giteaConfig.token: credentials are never imported");
    expect(result.body.summary.skipped.join("\n")).toContain("giteaConfig.somethingNew: not a setting in this version");
    expect(result.body.summary.skipped.join("\n")).toContain("notificationConfig.webhook.url");
    expect(result.body.summary.skipped.join("\n")).toContain("settings.extraSection");
    const after = await configOf("user-1");
    expect(decrypt!(after.giteaConfig.token)).toBe("gitea_destination_token");
    expect(after.giteaConfig.somethingNew).toBeUndefined();
    expect(after.notificationConfig.webhook.url).toBe("https://hooks.slack.com/services/T000/B000/XXXX");
  });

  test("a new interval clears the scheduler's next run, like a save", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    const config = await configOf("user-1");
    await db
      .update(schema.configs)
      .set({ scheduleConfig: { ...config.scheduleConfig, nextRun: at(99) } } as any)
      .where(eq(schema.configs.userId, "user-1"));
    file.settings.scheduleConfig.interval = "0 3 * * *";
    await importFile("user-1", file, { apply: true });
    const after = await configOf("user-1");
    expect(after.scheduleConfig.interval).toBe("0 3 * * *");
    expect(after.scheduleConfig.nextRun).toBeUndefined();
  });

  test("a repository in the middle of a sync keeps its ignore state and says so", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    await db
      .update(schema.repositories)
      .set({ status: "syncing" })
      .where(eq(schema.repositories.fullName, "octo/skipped"));
    const result = await importFile("user-1", file, { apply: true });
    expect(result.body.summary.skipped.join("\n")).toContain("octo/skipped: busy (syncing)");
    const [row] = await db.select().from(schema.repositories).where(eq(schema.repositories.fullName, "octo/skipped"));
    expect(row.status).toBe("syncing");
  });

  test("matches organizations and repositories by name in any case", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    file.organizations = [{ included: false, name: "ZETA", source: "github https://github.com octo" }];
    file.repositories = [{ fullName: "OCTO/Plain", ignored: true, source: "github https://github.com octo" }];
    const result = await importFile("user-1", file, { apply: true });
    expect(result.body.summary.organizations.updated).toEqual([
      { name: "zeta", source: "github https://github.com octo", changes: ["left out", "default destination", "mirror options cleared"] },
    ]);
    expect(result.body.summary.repositories.updated).toEqual([
      { name: "octo/plain", source: "github https://github.com octo", changes: ["ignored"] },
    ]);
  });

  test("never applies one source's choices to another source's row of the same name", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    // The file's "forgejo" org belongs to Codeberg; here only GitHub has one.
    await db.delete(schema.organizations).where(eq(schema.organizations.name, "forgejo"));
    const configId = (await configOf("user-1")).id;
    await db.insert(schema.organizations).values(org("user-1", configId, "a-gh", "forgejo", { isIncluded: true }) as any);
    file.organizations = [{ included: false, name: "forgejo", source: "gitea https://codeberg.org" }];
    const result = await importFile("user-1", file, { apply: true });
    expect(result.body.summary.organizations.updated).toEqual([]);
    expect(result.body.summary.organizations.notFound.map((o: any) => o.name)).toEqual(["forgejo"]);
    const [row] = await db.select().from(schema.organizations).where(eq(schema.organizations.name, "forgejo"));
    expect(row.isIncluded).toBe(true);
  });

  test("an organization pinned on one side only still matches by name", async () => {
    await seedSourceInstance();
    const file = JSON.parse(await exportText("user-1"));
    await db.update(schema.organizations).set({ sourceId: null }).where(eq(schema.organizations.name, "zeta"));
    file.organizations = [{ included: false, name: "zeta", source: "github https://github.com octo", destinationOrg: "zeta-mirrors", mirrorOverrides: { mirrorIssues: false, releaseLimit: 5 } }];
    const result = await importFile("user-1", file, { apply: true });
    expect(result.body.summary.organizations.updated).toEqual([
      { name: "zeta", source: "github https://github.com octo", changes: ["left out"] },
    ]);
  });

  test("a __proto__ key in the file is skipped and reaches nothing", async () => {
    await seedSourceInstance();
    const text = (await exportText("user-1")).replace('"giteaConfig": {', '"giteaConfig": { "__proto__": { "polluted": true },');
    const result = await importFile("user-1", JSON.parse(text), { apply: true });
    expect(result.status).toBe(200);
    expect(result.body.summary.skipped.join("\n")).toContain("giteaConfig.__proto__: not a setting");
    expect(({} as any).polluted).toBeUndefined();
    expect((await configOf("user-1")).giteaConfig.polluted).toBeUndefined();
  });

  test("a saved token with no address stays when the file does not change the address", async () => {
    await seedSourceInstance();
    const config = await configOf("user-1");
    await db
      .update(schema.configs)
      .set({ notificationConfig: { ...config.notificationConfig, apprise: { url: "", token: encrypt!("apprise_token") } } } as any)
      .where(eq(schema.configs.userId, "user-1"));
    const file = JSON.parse(await exportText("user-1"));
    file.settings.notificationConfig.notifyOnSyncError = false;
    const result = await importFile("user-1", file, { apply: true });
    expect(result.body.summary.todo).toEqual([]);
    expect(decrypt!((await configOf("user-1")).notificationConfig.apprise.token)).toBe("apprise_token");
  });

  test("a GitHub App source is added turned off, asking for the App details", async () => {
    const file = {
      format: "gitea-mirror-settings",
      version: 1,
      sources: [
        { authentication: "github-app", enabled: true, name: "Work app", provider: "github", reference: "github https://github.com work", url: "https://github.com", username: "work" },
      ],
      settings: {},
      organizations: [],
      repositories: [],
    };
    const result = await importFile("user-2", file, { apply: true });
    expect(result.status).toBe(200);
    expect(result.body.summary.todo).toEqual([
      "Enter the GitHub App details for the source Work app on the Connections tab, then turn it on.",
    ]);
    const [source] = await sourcesOf("user-2");
    expect(source.enabled).toBe(false);
    expect(source.token).toBeNull();
  });
});
