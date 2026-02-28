import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for gitea-mirror E2E tests.
 *
 * Expected services (started by run-e2e.sh before Playwright launches):
 *   - Fake GitHub API server on http://localhost:4580
 *   - Gitea instance on http://localhost:3333
 *   - gitea-mirror app on http://localhost:4321
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",

  /* Fail the build on CI if test.only is left in source */
  forbidOnly: !!process.env.CI,

  /* Retry once on CI to absorb flakiness from container startup races */
  retries: process.env.CI ? 1 : 0,

  /* Limit parallelism – the tests share a single Gitea + app instance */
  workers: 1,
  fullyParallel: false,

  /* Generous timeout: mirrors involve real HTTP round-trips to Gitea */
  timeout: 120_000,
  expect: { timeout: 15_000 },

  /* Reporter */
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never", outputFolder: "playwright-report" }],
      ]
    : [
        ["list"],
        ["html", { open: "on-failure", outputFolder: "playwright-report" }],
      ],

  outputDir: "test-results",

  use: {
    /* Base URL of the gitea-mirror app */
    baseURL: process.env.APP_URL || "http://localhost:4321",

    /* Collect traces on first retry so CI failures are debuggable */
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",

    /* Extra HTTP headers aren't needed but keep accept consistent */
    extraHTTPHeaders: {
      Accept: "application/json, text/html, */*",
    },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* We do NOT use webServer here because run-e2e.sh manages all services.
   * On CI the GitHub Action workflow starts them before invoking Playwright.
   * Locally, run-e2e.sh does the same.
   *
   * If you want Playwright to start the app for you during local dev, uncomment:
   *
   * webServer: [
   *   {
   *     command: "npx tsx tests/e2e/fake-github-server.ts",
   *     port: 4580,
   *     reuseExistingServer: true,
   *     timeout: 10_000,
   *   },
   *   {
   *     command: "bun run dev",
   *     port: 4321,
   *     reuseExistingServer: true,
   *     timeout: 30_000,
   *     env: {
   *       GITHUB_API_URL: "http://localhost:4580",
   *       BETTER_AUTH_SECRET: "e2e-test-secret",
   *     },
   *   },
   * ],
   */
});
