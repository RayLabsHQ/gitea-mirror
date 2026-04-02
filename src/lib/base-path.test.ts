import { afterEach, describe, expect, test } from "bun:test";

const originalBaseUrl = process.env.BASE_URL;

async function loadModule(baseUrl?: string) {
  if (baseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = baseUrl;
  }

  return import(`./base-path.ts?case=${encodeURIComponent(baseUrl ?? "default")}-${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  if (originalBaseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = originalBaseUrl;
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
});
