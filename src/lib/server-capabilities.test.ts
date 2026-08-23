import { describe, expect, test } from "bun:test";
import {
  ALL_CAPABILITIES,
  getCapabilityUnavailableReason,
  getPairCapabilities,
  getServerCapabilities,
} from "./server-capabilities";

describe("getServerCapabilities", () => {
  test("full forge types expose every capability", () => {
    for (const type of ["github", "gitlab", "gitea", "forgejo"] as const) {
      expect(getServerCapabilities(type).sort()).toEqual([...ALL_CAPABILITIES].sort());
    }
  });

  test("plain git servers expose refs only", () => {
    expect(getServerCapabilities("git")).toEqual(["refs"]);
  });

  test("plain git servers gain lfs when an LFS endpoint is configured", () => {
    expect(getServerCapabilities("git", { lfsEndpoint: "https://lfs.example.com" }).sort()).toEqual(
      ["lfs", "refs"],
    );
  });

  test("lfs endpoint does not change full forge capabilities", () => {
    expect(getServerCapabilities("gitea", { lfsEndpoint: "https://lfs.example.com" })).toEqual(
      getServerCapabilities("gitea"),
    );
  });
});

describe("getPairCapabilities", () => {
  test("git pairs expose only refs", () => {
    expect(getPairCapabilities("git", "gitea")).toEqual(["refs"]);
    expect(getPairCapabilities("github", "git")).toEqual(["refs"]);
    expect(getPairCapabilities("git", "git")).toEqual(["refs"]);
  });

  test("git pair with LFS endpoints on both sides exposes refs + lfs", () => {
    expect(
      getPairCapabilities("git", "git", {
        sourceLfsEndpoint: "https://lfs-a.example.com",
        targetLfsEndpoint: "https://lfs-b.example.com",
      }).sort(),
    ).toEqual(["lfs", "refs"]);
  });

  test("git pair with LFS endpoint on only one side stays refs-only", () => {
    expect(
      getPairCapabilities("git", "git", { sourceLfsEndpoint: "https://lfs-a.example.com" }),
    ).toEqual(["refs"]);
  });

  test("gitea <-> forgejo exposes everything", () => {
    expect(getPairCapabilities("gitea", "forgejo").sort()).toEqual([...ALL_CAPABILITIES].sort());
    expect(getPairCapabilities("github", "gitlab").sort()).toEqual([...ALL_CAPABILITIES].sort());
    expect(getPairCapabilities("github", "gitea").sort()).toEqual([...ALL_CAPABILITIES].sort());
  });
});

describe("getCapabilityUnavailableReason", () => {
  test("returns null for available capabilities", () => {
    expect(getCapabilityUnavailableReason("github", "issues")).toBeNull();
    expect(getCapabilityUnavailableReason("git", "refs")).toBeNull();
  });

  test("explains the git LFS endpoint requirement", () => {
    expect(getCapabilityUnavailableReason("git", "lfs")).toContain("LFS endpoint");
    expect(
      getCapabilityUnavailableReason("git", "lfs", { lfsEndpoint: "https://lfs.example.com" }),
    ).toBeNull();
  });

  test("explains unsupported content on plain git servers", () => {
    expect(getCapabilityUnavailableReason("git", "wiki")).toContain("git servers do not support");
  });
});
