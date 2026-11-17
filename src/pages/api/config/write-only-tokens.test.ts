/**
 * Saved tokens and secrets are write-only: no route sends them back, an
 * empty field keeps them, and a saved one only goes to the host it was saved
 * for. Covers GET and POST /api/config, the notification test and the
 * destination connection test against the real schema in an in-memory
 * SQLite database.
 *
 * mock.module is process-wide in bun, so the file runs itself in a child
 * process (see src/tests/isolated.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runsIsolated } from "@/tests/isolated";

const isChild = runsIsolated(import.meta.path);

process.env.ENCRYPTION_SECRET ??= "write-only-tokens-test-secret-0123456789";

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

const sentNotifications: any[] = [];
const giteaRequests: Array<{ url: string; headers: Record<string, string> }> = [];

if (isChild) {
  applyMigrations();
  sqlite.run("PRAGMA foreign_keys = OFF");

  const schema = await import("@/lib/db/schema");
  const outbound = await import("@/lib/utils/outbound-url");
  const httpClient = await import("@/lib/http-client");
  const notificationService = await import("@/lib/notification-service");

  mock.module("@/lib/db", () => ({ ...schema, db }));
  mock.module("@/lib/auth-guards", () => ({
    requireAuthenticatedUserId: mock(async () => ({ userId: "user-1" })),
  }));
  // No DNS lookups or outbound requests from the test.
  mock.module("@/lib/utils/outbound-url", () => ({
    ...outbound,
    blockedOutboundUrlReason: mock(async () => null),
    resolveOutboundTarget: mock(async (raw: string) => ({ url: new URL(raw), requestUrl: raw, headers: {} })),
  }));
  mock.module("@/lib/http-client", () => ({
    ...httpClient,
    httpGet: mock(async (url: string, headers: Record<string, string>) => {
      giteaRequests.push({ url, headers });
      return { data: url.endsWith("/version") ? { version: "1.24.0" } : { login: "me" }, status: 200, headers: {} };
    }),
  }));
  mock.module("@/lib/notification-service", () => ({
    ...notificationService,
    testNotification: mock(async (config: any) => {
      sentNotifications.push(config);
      return { success: true };
    }),
  }));
}

const { encrypt, decrypt } = await import("@/lib/utils/encryption");
const configRoute = isChild ? await import("./index") : null;
const notificationTestRoute = isChild ? await import("../notifications/test") : null;
const giteaTestRoute = isChild ? await import("../gitea/test-connection") : null;
const { configs, sources } = await import("@/lib/db/schema");

const SECRETS = {
  source: "ghp_saved_source_token",
  destination: "gitea_saved_destination_token",
  ntfy: "ntfy_saved_token",
  webhook: "whsec_saved_secret",
};

let stored: Record<keyof typeof SECRETS, string>;

function seed(): void {
  stored = {
    source: encrypt(SECRETS.source),
    destination: encrypt(SECRETS.destination),
    ntfy: encrypt(SECRETS.ntfy),
    webhook: encrypt(SECRETS.webhook),
  };
  sqlite.run("DELETE FROM configs");
  sqlite.run("DELETE FROM sources");
  db.insert(configs)
    .values({
      id: "config-1",
      userId: "user-1",
      name: "Default Configuration",
      isActive: true,
      githubConfig: {
        owner: "octo",
        provider: "github",
        type: "personal",
        token: stored.source,
        includeStarred: false,
        includePrivate: true,
        includeForks: true,
        skipForks: false,
        includeArchived: false,
        includePublic: true,
        includeOrganizations: [],
        starredReposOrg: "starred",
        mirrorStrategy: "preserve",
        defaultOrg: "github-mirrors",
      } as any,
      giteaConfig: {
        provider: "gitea",
        url: "https://git.example.com",
        defaultOwner: "me",
        token: stored.destination,
        visibility: "public",
        preserveVisibility: false,
      } as any,
      include: [],
      exclude: [],
      scheduleConfig: { enabled: false, interval: "8h" } as any,
      cleanupConfig: { enabled: false, retentionDays: 604800 } as any,
      notificationConfig: {
        enabled: true,
        provider: "ntfy",
        notifyOnSyncError: true,
        notifyOnSyncSuccess: false,
        notifyOnNewRepo: false,
        notifyOnNewOwnRepo: true,
        notifyOnNewOrgRepo: true,
        notifyOnNewStarredRepo: true,
        ntfy: { url: "https://ntfy.example.com", topic: "mirror", token: stored.ntfy, priority: "default" },
        webhook: { url: "https://hooks.example.com", secret: stored.webhook },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

function storedRow(): any {
  return db.select().from(configs).all()[0];
}

const locals = { session: { userId: "user-1" } } as any;

async function getConfig(): Promise<{ text: string; body: any }> {
  const response = await configRoute!.GET({ request: new Request("http://localhost/api/config"), locals } as any);
  expect(response.status).toBe(200);
  const text = await response.text();
  return { text, body: JSON.parse(text) };
}

async function postConfig(body: any): Promise<Response> {
  return configRoute!.POST({
    request: new Request("http://localhost/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals,
  } as any);
}

/** What the Configuration page sends back: the GET body with some fields changed. */
function saveBody(config: any, changes: Record<string, any> = {}) {
  return {
    githubConfig: config.githubConfig,
    giteaConfig: config.giteaConfig,
    scheduleConfig: config.scheduleConfig,
    cleanupConfig: config.cleanupConfig,
    mirrorOptions: config.mirrorOptions,
    advancedOptions: config.advancedOptions,
    notificationConfig: config.notificationConfig,
    ...changes,
  };
}

describe.skipIf(!isChild)("write-only tokens", () => {
  beforeEach(() => {
    seed();
    sentNotifications.length = 0;
    giteaRequests.length = 0;
  });

  test("GET /api/config returns no token, encrypted or not, only whether one is saved", async () => {
    const { text, body } = await getConfig();

    for (const value of [...Object.values(SECRETS), ...Object.values(stored)]) {
      expect(text).not.toContain(value);
    }
    expect(body.githubConfig).toMatchObject({ token: "", hasToken: true });
    expect(body.giteaConfig).toMatchObject({ token: "", hasToken: true, url: "https://git.example.com" });
    expect(body.notificationConfig.ntfy).toMatchObject({ token: "", hasToken: true, topic: "mirror" });
    expect(body.notificationConfig.webhook).toMatchObject({ secret: "", hasSecret: true });
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({ provider: "github", hasToken: true });
    expect(body.sources[0]).not.toHaveProperty("token");
  });

  test("saving the page as loaded keeps every saved secret", async () => {
    const { body } = await getConfig();
    const response = await postConfig(saveBody(body));
    expect(response.status).toBe(200);

    const row = storedRow();
    expect(decrypt(row.githubConfig.token)).toBe(SECRETS.source);
    expect(decrypt(row.giteaConfig.token)).toBe(SECRETS.destination);
    expect(decrypt(row.notificationConfig.ntfy.token)).toBe(SECRETS.ntfy);
    expect(decrypt(row.notificationConfig.webhook.secret)).toBe(SECRETS.webhook);
    expect(row.notificationConfig.ntfy).not.toHaveProperty("hasToken");
  });

  test("a new destination token replaces the saved one", async () => {
    const { body } = await getConfig();
    const response = await postConfig(saveBody(body, { giteaConfig: { ...body.giteaConfig, token: "gitea_new" } }));
    expect(response.status).toBe(200);
    expect(decrypt(storedRow().giteaConfig.token)).toBe("gitea_new");
  });

  test("the saved destination token does not follow the URL to another host", async () => {
    const { body } = await getConfig();
    const moved = { ...body.giteaConfig, url: "https://evil.example.net" };

    const refused = await postConfig(saveBody(body, { giteaConfig: moved }));
    expect(refused.status).toBe(400);
    expect((await refused.json()).message).toBe(
      "Enter a Gitea token for evil.example.net. The saved one is only sent to git.example.com."
    );
    expect(storedRow().giteaConfig.url).toBe("https://git.example.com");

    const sameServer = await postConfig(
      saveBody(body, { giteaConfig: { ...body.giteaConfig, url: "http://git.example.com:3000" } })
    );
    expect(sameServer.status).toBe(200);
    expect(decrypt(storedRow().giteaConfig.token)).toBe(SECRETS.destination);

    const withToken = await postConfig(saveBody(body, { giteaConfig: { ...moved, token: "token_for_new_host" } }));
    expect(withToken.status).toBe(200);
    expect(storedRow().giteaConfig.url).toBe("https://evil.example.net");
    expect(decrypt(storedRow().giteaConfig.token)).toBe("token_for_new_host");
  });

  test("null removes a notification secret and leaves the others", async () => {
    const { body } = await getConfig();
    const notificationConfig = {
      ...body.notificationConfig,
      ntfy: { ...body.notificationConfig.ntfy, token: null, hasToken: false },
    };
    const response = await postConfig(saveBody(body, { notificationConfig }));
    expect(response.status).toBe(200);

    const row = storedRow();
    expect(row.notificationConfig.ntfy.token).toBe("");
    expect(decrypt(row.notificationConfig.webhook.secret)).toBe(SECRETS.webhook);

    const { body: after } = await getConfig();
    expect(after.notificationConfig.ntfy.hasToken).toBe(false);
  });

  test("the notification test uses the saved token, for the saved host only", async () => {
    const { body } = await getConfig();
    const send = (notificationConfig: any) =>
      notificationTestRoute!.POST({
        request: new Request("http://localhost/api/notifications/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notificationConfig }),
        }),
        locals,
      } as any);

    const ok = await send(body.notificationConfig);
    expect(ok.status).toBe(200);
    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0].ntfy.token).toBe(SECRETS.ntfy);

    const moved = await send({
      ...body.notificationConfig,
      ntfy: { ...body.notificationConfig.ntfy, url: "https://evil.example.net" },
    });
    expect(moved.status).toBe(400);
    expect(sentNotifications).toHaveLength(1);
  });

  test("the destination test uses the saved token, for the saved host only", async () => {
    const run = (url: string) =>
      giteaTestRoute!.POST({
        request: new Request("http://localhost/api/gitea/test-connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "gitea", url, token: "" }),
        }),
        locals,
      } as any);

    const ok = await run("https://git.example.com");
    expect(ok.status).toBe(200);
    expect(giteaRequests[0].headers.Authorization).toBe(`token ${SECRETS.destination}`);

    giteaRequests.length = 0;
    const moved = await run("https://evil.example.net");
    expect(moved.status).toBe(400);
    expect((await moved.json()).message).toBe(
      "Enter a Gitea token for evil.example.net. The saved one is only sent to git.example.com."
    );
    expect(giteaRequests).toHaveLength(0);
  });

  test("the sources table is left untouched by a config save", async () => {
    await getConfig();
    const before = db.select().from(sources).all();
    const { body } = await getConfig();
    await postConfig(saveBody(body));
    expect(db.select().from(sources).all()).toEqual(before);
  });
});
