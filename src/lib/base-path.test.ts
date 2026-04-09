import { afterEach, describe, expect, test } from "bun:test";

const originalBaseUrl = process.env.BASE_URL;
const originalWindow = (globalThis as { window?: unknown }).window;

async function loadModule(baseUrl?: string, runtimeWindowBasePath?: string) {
  if (baseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = baseUrl;
  }

  if (runtimeWindowBasePath === undefined) {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
      const restoredWindow = (globalThis as { window?: { __GITEA_MIRROR_BASE_PATH__?: string } }).window;
      if (typeof restoredWindow === "object" && restoredWindow !== null) {
        delete restoredWindow.__GITEA_MIRROR_BASE_PATH__;
      }
    }
  } else {
    (globalThis as { window?: { __GITEA_MIRROR_BASE_PATH__?: string } }).window = {
      __GITEA_MIRROR_BASE_PATH__: runtimeWindowBasePath,
    };
  }

  return import(`./base-path.ts?case=${encodeURIComponent(baseUrl ?? "default")}-${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  if (originalBaseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = originalBaseUrl;
  }

  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe("base-path helpers", () => {
  test("defaults to root paths", async () => {
    const mod = await loadModule(undefined);

    expect(mod.BASE_PATH).toBe("/");
    expect(mod.withBase("/api/health")).toBe("/api/health");
    expect(mod.withBase("repositories")).toBe("/repositories");
    expect(mod.stripBasePath("/config")).toBe("/config");
  });

  test("normalizes prefixed base paths", async () => {
    const mod = await loadModule("mirror/");

    expect(mod.BASE_PATH).toBe("/mirror");
    expect(mod.withBase("/api/health")).toBe("/mirror/api/health");
    expect(mod.withBase("repositories")).toBe("/mirror/repositories");
    expect(mod.stripBasePath("/mirror/config")).toBe("/config");
    expect(mod.stripBasePath("/mirror")).toBe("/");
  });

  test("keeps absolute URLs unchanged", async () => {
    const mod = await loadModule("/mirror");

    expect(mod.withBase("https://example.com/path")).toBe("https://example.com/path");
  });

  test("uses browser runtime base path when process env is unset", async () => {
    const mod = await loadModule(undefined, "/runtime");

    expect(mod.BASE_PATH).toBe("/runtime");
    expect(mod.withBase("/api/health")).toBe("/runtime/api/health");
    expect(mod.stripBasePath("/runtime/config")).toBe("/config");
  });

  test("prefers process env base path over browser runtime value", async () => {
    const mod = await loadModule("/env", "/runtime");

    expect(mod.BASE_PATH).toBe("/env");
    expect(mod.withBase("/api/health")).toBe("/env/api/health");
  });
});
