import { describe, expect, test } from "bun:test";
import { supportsMirrorCredentialUpdate } from "./gitea-mirror-credentials";

describe("supportsMirrorCredentialUpdate", () => {
  test("accepts Gitea 1.27 and the 28+ version line", () => {
    for (const version of ["1.27.0", "1.27.3", "v1.27.1", "1.28.0", "28.2.0", "29.0.0+dev-160-g55186ca39b"]) {
      expect(supportsMirrorCredentialUpdate(version)).toBe(true);
    }
  });

  test("rejects Gitea 1.26 and earlier, which drop the mirror credential fields", () => {
    for (const version of ["1.26.1", "1.24.7", "1.20.0"]) {
      expect(supportsMirrorCredentialUpdate(version)).toBe(false);
    }
  });

  test("rejects Forgejo whatever its own version number", () => {
    for (const version of ["11.0.3+gitea-1.22.0", "16.0.0-dev-785-465b60ef+gitea-1.22.0"]) {
      expect(supportsMirrorCredentialUpdate(version)).toBe(false);
    }
  });

  test("rejects a missing or unparsable version", () => {
    expect(supportsMirrorCredentialUpdate("")).toBe(false);
    expect(supportsMirrorCredentialUpdate("development")).toBe(false);
  });
});
