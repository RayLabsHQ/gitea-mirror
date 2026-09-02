import { describe, expect, test } from "bun:test";
import {
  computeConfigLocks,
  evaluateConfigChange,
  hasDestinationChanged,
  hasSourceChanged,
  loadConfigLocks,
  normalizeDestinationUrl,
  sourceIdentity,
} from "./config-locks";

describe("computeConfigLocks", () => {
  test("locks the source once anything is imported and the destination once anything is mirrored", () => {
    expect(computeConfigLocks({ repositoryCount: 0, mirroredCount: 0 })).toEqual({
      source: { locked: false, repositoryCount: 0 },
      destination: { locked: false, mirroredCount: 0 },
    });
    expect(computeConfigLocks({ repositoryCount: 3, mirroredCount: 0 })).toMatchObject({
      source: { locked: true },
      destination: { locked: false },
    });
    expect(computeConfigLocks({ repositoryCount: 3, mirroredCount: 1 }).destination.locked).toBe(true);
  });
});

describe("hasSourceChanged", () => {
  test("legacy rows without a provider are GitHub and match a GitHub payload with any URL", () => {
    expect(hasSourceChanged({}, { provider: "github", url: "https://github.com" })).toBe(false);
    expect(hasSourceChanged({ provider: "github" }, { provider: "github", url: "" })).toBe(false);
  });

  test("cosmetic URL edits are not a change, another host is", () => {
    expect(
      hasSourceChanged(
        { provider: "gitlab", url: "https://gitlab.example.com" },
        { provider: "gitlab", url: "GitLab.example.com/" }
      )
    ).toBe(false);
    expect(hasSourceChanged({ provider: "gitlab" }, { provider: "gitlab", url: "https://gitlab.example.com" })).toBe(true);
    expect(hasSourceChanged({ provider: "github" }, { provider: "gitea" })).toBe(true);
  });

  test("sourceIdentity describes GitHub with its fixed URL", () => {
    expect(sourceIdentity({ provider: "github", url: "https://ghe.example.com" })).toEqual({
      provider: "github",
      url: "https://github.com",
    });
  });
});

describe("hasDestinationChanged", () => {
  test("ignores trailing slashes and host case, and never fires while a side is empty", () => {
    expect(hasDestinationChanged("https://Gitea.example.com/", "https://gitea.example.com")).toBe(false);
    expect(hasDestinationChanged("https://gitea.example.com", "https://other.example.com")).toBe(true);
    expect(hasDestinationChanged("", "https://gitea.example.com")).toBe(false);
    expect(hasDestinationChanged("https://gitea.example.com", "")).toBe(false);
    expect(normalizeDestinationUrl(" https://gitea.example.com/gitea// ")).toBe("https://gitea.example.com/gitea");
  });
});

describe("evaluateConfigChange", () => {
  const locked = computeConfigLocks({ repositoryCount: 12, mirroredCount: 4 });
  const unlocked = computeConfigLocks({ repositoryCount: 0, mirroredCount: 0 });
  const base = {
    existingSource: { provider: "github" },
    incomingSource: { provider: "github", url: "" },
    existingDestinationUrl: "https://gitea.example.com",
    incomingDestinationUrl: "https://gitea.example.com",
  };

  test("an unchanged save always passes", () => {
    expect(evaluateConfigChange({ locks: locked, ...base })).toEqual({ ok: true });
  });

  test("everything passes while nothing is imported", () => {
    expect(
      evaluateConfigChange({
        locks: unlocked,
        ...base,
        incomingSource: { provider: "gitlab" },
        incomingDestinationUrl: "https://other.example.com",
      })
    ).toEqual({ ok: true });
  });

  test("a locked source refuses a provider change without confirmation and names both hosts", () => {
    const verdict = evaluateConfigChange({
      locks: locked,
      ...base,
      incomingSource: { provider: "gitlab", url: "https://gitlab.example.com" },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.lock).toBe("source");
    expect(verdict.message).toContain("12 repositories were imported from GitHub (https://github.com)");
    expect(verdict.message).toContain("GitLab (https://gitlab.example.com)");
  });

  test("the confirm flag lets a locked source change through", () => {
    expect(
      evaluateConfigChange({
        locks: locked,
        ...base,
        incomingSource: { provider: "gitlab" },
        confirmSourceChange: true,
      })
    ).toEqual({ ok: true });
  });

  test("a locked destination refuses a server URL change without confirmation", () => {
    const verdict = evaluateConfigChange({
      locks: locked,
      ...base,
      incomingDestinationUrl: "https://other.example.com/",
    });
    expect(verdict).toMatchObject({ ok: false, lock: "destination" });
    if (verdict.ok) return;
    expect(verdict.message).toContain("4 repositories are mirrored to https://gitea.example.com");

    expect(
      evaluateConfigChange({
        locks: locked,
        ...base,
        incomingDestinationUrl: "https://other.example.com/",
        confirmDestinationChange: true,
      })
    ).toEqual({ ok: true });
  });

  test("the source is reported before the destination when both change", () => {
    const verdict = evaluateConfigChange({
      locks: locked,
      ...base,
      incomingSource: { provider: "gitea" },
      incomingDestinationUrl: "https://other.example.com",
    });
    expect(verdict).toMatchObject({ ok: false, lock: "source" });
  });
});

describe("loadConfigLocks", () => {
  test("resolves to unlocked when the database layer misbehaves", async () => {
    // The global test setup stubs @/lib/db with a select chain that never
    // yields rows, so the count cannot be read. That must not throw.
    expect(await loadConfigLocks("user-1")).toEqual({
      source: { locked: false, repositoryCount: 0 },
      destination: { locked: false, mirroredCount: 0 },
    });
  });
});
