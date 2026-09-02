/**
 * 07 – Reconcile with the destination (issue #284).
 *
 * Forgets a mirrored repository in the app database, checks that reconcile
 * reports the Gitea mirror as untracked and adopts it back, then deletes a
 * mirror on Gitea directly, checks that reconcile reports the row as
 * missing and resets it for the next mirror run.
 */

import { test, expect } from "@playwright/test";
import { APP_URL, GITEA_URL, GiteaAPI, getAppSessionCookies } from "./helpers";

const RECONCILE_URL = `${APP_URL}/api/cleanup/reconcile`;

async function listTracked(request: any, cookies: string): Promise<any[]> {
  const resp = await request.get(`${APP_URL}/api/github/repositories`, {
    headers: { Cookie: cookies },
    failOnStatusCode: false,
  });
  expect(resp.status(), await resp.text()).toBe(200);
  const body = await resp.json();
  return body.repositories ?? [];
}

async function reconcile(request: any, cookies: string, body: Record<string, unknown>) {
  const resp = await request.post(RECONCILE_URL, {
    headers: { Cookie: cookies, "Content-Type": "application/json" },
    data: body,
    failOnStatusCode: false,
  });
  expect(resp.status(), await resp.text()).toBe(200);
  return resp.json();
}

test.describe("E2E: reconcile with the destination", () => {
  let cookies = "";
  let giteaApi: GiteaAPI;
  let forgotten: any = null;
  let removed: any = null;

  test.beforeAll(async () => {
    giteaApi = new GiteaAPI(GITEA_URL);
  });

  test.afterAll(async () => {
    await giteaApi.dispose();
  });

  test("Step 1: a dry run answers with the report shape", async ({ request }) => {
    cookies = await getAppSessionCookies(request);
    const result = await reconcile(request, cookies, {});
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBeNull();
    expect(Array.isArray(result.report.untracked)).toBeTruthy();
    expect(Array.isArray(result.report.missing)).toBeTruthy();
    expect(Array.isArray(result.report.notManaged)).toBeTruthy();
    expect(result.report.scannedOwners.length).toBeGreaterThan(0);
    console.log(
      `[Reconcile] ${result.report.totalOnDestination} on destination, ${result.report.healthyCount} healthy, ` +
        `${result.report.untracked.length} untracked, ${result.report.missing.length} missing, ${result.report.notManaged.length} not managed`,
    );
  });

  test("Step 2: a mirror the database forgot is reported as untracked", async ({ request }) => {
    const mirrored = (await listTracked(request, cookies)).filter(
      (r: any) => ["mirrored", "synced"].includes(r.status) && r.mirroredLocation,
    );
    expect(mirrored.length, "spec 02 must have mirrored repositories").toBeGreaterThanOrEqual(2);
    forgotten = mirrored[0];
    removed = mirrored[1];

    const del = await request.delete(`${APP_URL}/api/repositories`, {
      headers: { Cookie: cookies, "Content-Type": "application/json" },
      data: { ids: [forgotten.id] },
      failOnStatusCode: false,
    });
    expect(del.status(), await del.text()).toBe(200);
    console.log(`[Reconcile] Forgot ${forgotten.fullName} (was at ${forgotten.mirroredLocation})`);

    const result = await reconcile(request, cookies, { dryRun: true });
    const locations = result.report.untracked.map((r: any) => r.location.toLowerCase());
    expect(locations).toContain(forgotten.mirroredLocation.toLowerCase());
  });

  test("Step 3: adopting brings the row back as mirrored", async ({ request }) => {
    const result = await reconcile(request, cookies, { dryRun: false, adoptUntracked: true });
    expect(result.dryRun).toBe(false);
    expect(result.applied.adopted).toBeGreaterThanOrEqual(1);

    const rows = await listTracked(request, cookies);
    const back = rows.find(
      (r: any) => r.fullName.toLowerCase() === forgotten.fullName.toLowerCase(),
    );
    expect(back, `expected ${forgotten.fullName} to be tracked again`).toBeTruthy();
    expect(back.status).toBe("mirrored");
    expect(back.mirroredLocation.toLowerCase()).toBe(forgotten.mirroredLocation.toLowerCase());

    const again = await reconcile(request, cookies, { dryRun: true });
    const locations = again.report.untracked.map((r: any) => r.location.toLowerCase());
    expect(locations).not.toContain(forgotten.mirroredLocation.toLowerCase());
  });

  test("Step 4: a mirror deleted on the destination is reported as missing and can be reset", async ({
    request,
  }) => {
    const [owner, name] = removed.mirroredLocation.split("/");
    expect(await giteaApi.deleteRepo(owner, name)).toBeTruthy();
    expect(await giteaApi.getRepo(owner, name)).toBeNull();
    console.log(`[Reconcile] Deleted ${removed.mirroredLocation} on Gitea`);

    const dry = await reconcile(request, cookies, { dryRun: true });
    const missingIds = dry.report.missing.map((r: any) => r.id);
    expect(missingIds).toContain(removed.id);

    const applied = await reconcile(request, cookies, { dryRun: false, resetMissing: true });
    expect(applied.applied.reset).toBeGreaterThanOrEqual(1);

    const rows = await listTracked(request, cookies);
    const row = rows.find((r: any) => r.id === removed.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe("imported");
    expect(row.mirroredLocation ?? "").toBe("");
  });
});
