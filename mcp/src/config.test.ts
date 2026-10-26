import { describe, expect, test } from "bun:test";
import { ConfigError, readConfig } from "./config";

const KEY = "gm_test";

describe("readConfig", () => {
  test("keeps the origin and the BASE_URL prefix, without a trailing slash", () => {
    expect(readConfig({ GITEA_MIRROR_URL: "https://mirror.example.com/", GITEA_MIRROR_API_KEY: KEY })).toEqual({
      baseUrl: "https://mirror.example.com",
      apiKey: KEY,
    });
    expect(
      readConfig({ GITEA_MIRROR_URL: " http://nas.local:4321/mirror// ", GITEA_MIRROR_API_KEY: ` ${KEY} ` })
    ).toEqual({ baseUrl: "http://nas.local:4321/mirror", apiKey: KEY });
  });

  test("needs both variables", () => {
    expect(() => readConfig({ GITEA_MIRROR_API_KEY: KEY })).toThrow(/GITEA_MIRROR_URL is not set/);
    expect(() => readConfig({ GITEA_MIRROR_URL: "https://mirror.example.com" })).toThrow(
      /GITEA_MIRROR_API_KEY is not set/
    );
    expect(() => readConfig({ GITEA_MIRROR_URL: "https://mirror.example.com", GITEA_MIRROR_API_KEY: "  " })).toThrow(
      ConfigError
    );
  });

  test("rejects addresses that are not a plain http(s) URL", () => {
    expect(() => readConfig({ GITEA_MIRROR_URL: "mirror.example.com", GITEA_MIRROR_API_KEY: KEY })).toThrow(
      /not a URL/
    );
    expect(() => readConfig({ GITEA_MIRROR_URL: "ftp://mirror.example.com", GITEA_MIRROR_API_KEY: KEY })).toThrow(
      /http:\/\/ or https:\/\//
    );
    expect(() =>
      readConfig({ GITEA_MIRROR_URL: "https://mirror.example.com/?x=1", GITEA_MIRROR_API_KEY: KEY })
    ).toThrow(/without credentials, a query/);
    expect(() =>
      readConfig({ GITEA_MIRROR_URL: "https://user:pw@mirror.example.com", GITEA_MIRROR_API_KEY: KEY })
    ).toThrow(ConfigError);
  });
});
