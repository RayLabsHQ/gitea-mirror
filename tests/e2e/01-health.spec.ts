/**
 * 01 – Service health checks.
 *
 * Quick smoke tests that confirm every service required by the E2E suite is
 * reachable before the heavier workflow tests run.
 */

import { test, expect } from "@playwright/test";
import {
  APP_URL,
  GITEA_URL,
  FAKE_GITHUB_URL,
  GIT_SERVER_URL,
  waitFor,
} from "./helpers";

test.describe("E2E: Service health checks", () => {
  test("Fake GitHub API is running", async ({ request }) => {
    const resp = await request.get(`${FAKE_GITHUB_URL}/___mgmt/health`);
    expect(resp.ok()).toBeTruthy();
    const data = await resp.json();
    expect(data.status).toBe("ok");
    expect(data.repos).toBeGreaterThan(0);
    console.log(
      `[Health] Fake GitHub: ${data.repos} repos, ${data.orgs} orgs, clone base: ${data.gitCloneBaseUrl ?? "default"}`,
    );
  });

  test("Git HTTP server is running (serves test repos)", async ({
    request,
  }) => {
    const resp = await request.get(`${GIT_SERVER_URL}/manifest.json`, {
      failOnStatusCode: false,
    });
    expect(resp.ok(), "Git server should serve manifest.json").toBeTruthy();
    const manifest = await resp.json();
    expect(manifest.repos).toBeDefined();
    expect(manifest.repos.length).toBeGreaterThan(0);
    console.log(`[Health] Git server: serving ${manifest.repos.length} repos`);
    for (const r of manifest.repos) {
      console.log(`[Health]   • ${r.owner}/${r.name} — ${r.description}`);
    }
  });

  test("Gitea instance is running", async ({ request }) => {
    await waitFor(
      async () => {
        const resp = await request.get(`${GITEA_URL}/api/v1/version`, {
          failOnStatusCode: false,
        });
        return resp.ok();
      },
      { timeout: 30_000, interval: 2_000, label: "Gitea healthy" },
    );
    const resp = await request.get(`${GITEA_URL}/api/v1/version`);
    const data = await resp.json();
    console.log(`[Health] Gitea version: ${data.version}`);
    expect(data.version).toBeTruthy();
  });

  test("gitea-mirror app is running", async ({ request }) => {
    await waitFor(
      async () => {
        const resp = await request.get(`${APP_URL}/`, {
          failOnStatusCode: false,
        });
        return resp.status() < 500;
      },
      { timeout: 60_000, interval: 2_000, label: "App healthy" },
    );
    const resp = await request.get(`${APP_URL}/`, {
      failOnStatusCode: false,
    });
    console.log(`[Health] App status: ${resp.status()}`);
    expect(resp.status()).toBeLessThan(500);
  });
});
