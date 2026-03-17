import { describe, expect, it } from "bun:test";
import { buildGiteaWebUrl, getGiteaWebBaseUrl } from "@/lib/gitea-url";

describe("getGiteaWebBaseUrl", () => {
  it("prefers externalUrl when both urls are present", () => {
    const baseUrl = getGiteaWebBaseUrl({
      url: "http://gitea:3000",
      externalUrl: "https://git.example.com",
    });

    expect(baseUrl).toBe("https://git.example.com");
  });

  it("falls back to url when externalUrl is missing", () => {
    const baseUrl = getGiteaWebBaseUrl({
      url: "http://gitea:3000",
    });

    expect(baseUrl).toBe("http://gitea:3000");
  });

  it("trims a trailing slash", () => {
    const baseUrl = getGiteaWebBaseUrl({
      externalUrl: "https://git.example.com/",
    });

    expect(baseUrl).toBe("https://git.example.com");
  });
});

describe("buildGiteaWebUrl", () => {
  it("builds a full repository url and removes leading path slashes", () => {
    const url = buildGiteaWebUrl(
      { externalUrl: "https://git.example.com/" },
      "/org/repo"
    );

    expect(url).toBe("https://git.example.com/org/repo");
  });

  it("returns null when no gitea url is configured", () => {
    const url = buildGiteaWebUrl({}, "org/repo");
    expect(url).toBeNull();
  });
});
