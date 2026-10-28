import { afterEach, describe, expect, test } from "bun:test";
import { internalApiBaseUrl } from "./internal-url";

const originalBaseUrl = process.env.BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = originalBaseUrl;
});

describe("internalApiBaseUrl", () => {
  test("reaches a wildcard host through loopback", () => {
    delete process.env.BASE_URL;
    expect(internalApiBaseUrl({ HOST: "0.0.0.0", PORT: "4321" })).toBe("http://127.0.0.1:4321");
    expect(internalApiBaseUrl({ HOST: "::", PORT: "8080" })).toBe("http://[::1]:8080");
  });

  test("uses a specific host as is and defaults like the node adapter", () => {
    delete process.env.BASE_URL;
    expect(internalApiBaseUrl({ HOST: "10.0.0.5", PORT: "4000" })).toBe("http://10.0.0.5:4000");
    expect(internalApiBaseUrl({ HOST: "fd00::5", PORT: "4000" })).toBe("http://[fd00::5]:4000");
    expect(internalApiBaseUrl({})).toBe("http://localhost:4321");
  });

  test("keeps the BASE_URL prefix", () => {
    process.env.BASE_URL = "/mirror/";
    expect(internalApiBaseUrl({ HOST: "0.0.0.0", PORT: "4321" })).toBe("http://127.0.0.1:4321/mirror");
  });

  test("MCP_INTERNAL_URL overrides everything", () => {
    expect(internalApiBaseUrl({ MCP_INTERNAL_URL: "http://app:9000/x/", HOST: "0.0.0.0" })).toBe("http://app:9000/x");
  });
});
