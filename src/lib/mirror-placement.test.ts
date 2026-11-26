/**
 * Which mirrors move when the settings change, and what the preview plans
 * for each (#550). The destination is a small in-memory model with Gitea's
 * rules: names are case-insensitive, a rename or move leaves a redirect,
 * and a redirect does not hold a name.
 */
import { describe, expect, test } from "bun:test";
import { runsIsolated } from "@/tests/isolated";
import type { PlacementScan, PlacementScanRow } from "./mirror-placement";
import type { PlacementDeps } from "./mirror-placement-service";

// Other files mock modules these import; run this file on its own.
const isChild = runsIsolated(import.meta.path);
const { scanPlacement, placementBarMode } = (isChild ? await import("./mirror-placement") : {}) as typeof import("./mirror-placement");
const { previewPlacement } = (isChild ? await import("./mirror-placement-service") : {}) as typeof import("./mirror-placement-service");

type Repo = { owner: string; name: string; mirror: boolean; original_url?: string; admin?: boolean };

function destination() {
  const repos = new Map<string, Repo>();
  const redirects = new Map<string, string>();
  const orgs = new Set<string>(["mirrors"]);
  const users = new Set<string>(["me"]);
  const noCreate = new Set<string>();
  let isAdmin = true;
  const key = (o: string, n: string) => `${o}/${n}`.toLowerCase();
  const info = (r: Repo) => ({
    id: 1,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner },
    mirror: r.mirror,
    original_url: r.original_url ?? "",
    permissions: { admin: r.admin ?? true, push: true, pull: true },
  });
  const deps: PlacementDeps = {
    me: async () => ({ login: "me", isAdmin }),
    ownerKind: async (name) =>
      orgs.has(name.toLowerCase()) ? "organization" : users.has(name.toLowerCase()) ? "user" : "missing",
    canCreateIn: async (org) => !noCreate.has(org.toLowerCase()),
    lookup: async (owner, name) => {
      let k = key(owner, name);
      if (!repos.has(k) && redirects.has(k)) k = redirects.get(k)!;
      const r = repos.get(k);
      return r ? (info(r) as any) : null;
    },
    probe: async (owner, name) => {
      const r = repos.get(key(owner, name));
      return r ? { state: "taken", info: info(r) as any } : { state: "free" };
    },
    searchBySource: async (row) => {
      for (const r of repos.values()) if (r.mirror && r.original_url === row.cloneUrl) return info(r) as any;
      return null;
    },
  };
  return {
    deps,
    add: (r: Repo) => {
      repos.set(key(r.owner, r.name), r);
      orgs.add(r.owner.toLowerCase());
    },
    redirect: (from: string, to: string) => redirects.set(from.toLowerCase(), to.toLowerCase()),
    org: (name: string) => orgs.add(name.toLowerCase()),
    user: (name: string) => users.add(name.toLowerCase()),
    noCreate: (name: string) => noCreate.add(name.toLowerCase()),
    setAdmin: (value: boolean) => (isAdmin = value),
  };
}

const url = (full: string) => `https://github.com/${full}.git`;

/** A mirrored row and where the settings want it. */
function scanRow(full: string, location: string, targetOwner: string | null, extra: Partial<PlacementScanRow["row"]> = {}, onConfiguredDestination = true): PlacementScanRow {
  const name = full.split("/")[1];
  return {
    row: { id: full, fullName: full, name, cloneUrl: url(full), mirroredLocation: location, status: "mirrored", ...extra } as any,
    target: targetOwner === null ? null : { owner: targetOwner, via: "strategy" },
    onConfiguredDestination,
  };
}

const config = { giteaConfig: { defaultOwner: "me" } } as any;
const preview = (scan: PlacementScan, deps: PlacementDeps, rename = true) =>
  previewPlacement({ scan, config, rename, deps });

describe.skipIf(!isChild)("scanPlacement", () => {
  test("only the owner decides; never-mirrored and ignored rows are left out", () => {
    const scan = scanPlacement([
      scanRow("jeff/bar", "Mirrors/Jeffs-Bar", "jeff"),
      scanRow("me/foo", "me/foo-renamed", "me"),
      scanRow("me/new", "", "me"),
      scanRow("me/quiet", "Mirrors/quiet", "me", { status: "ignored" }),
    ]);
    expect(scan.candidates.map((c) => c.fullName)).toEqual(["jeff/bar"]);
    expect(scan.inPlace).toBe(1);
    expect(scan.skipped).toEqual([]);
  });

  test("says why a mirror is not looked at", () => {
    const scan = scanPlacement([
      scanRow("a/one", "Mirrors/archived-one", "a"),
      scanRow("a/two", "Mirrors/two", "a", { status: "archived" }),
      scanRow("a/three", "Mirrors/three", "a", { sourceMissingSince: new Date() }),
      scanRow("a/four", "Mirrors/four", "a", { status: "syncing" }),
      scanRow("a/five", "Mirrors/five", "a", {}, false),
      scanRow("a/six", "Mirrors/six", null),
    ]);
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((s) => `${s.fullName}: ${s.reason}`)).toEqual([
      "a/five: mirrored to a different destination",
      "a/four: a sync is in progress",
      "a/one: archived after its source disappeared",
      "a/six: no destination could be worked out from the settings",
      "a/three: its source is gone and cleanup is waiting to act",
      "a/two: archived after its source disappeared",
    ]);
  });
});

describe.skipIf(!isChild)("previewPlacement", () => {
  test("moves into a new organization under the source's name", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "Jeffs-Bar", mirror: true, original_url: url("jeff/bar") });
    const result = await preview(scanPlacement([scanRow("jeff/bar", "Mirrors/Jeffs-Bar", "JeffsOrg")]), d.deps);
    expect(result.blocked).toEqual([]);
    expect(result.moves).toMatchObject([
      { from: "Mirrors/Jeffs-Bar", to: "JeffsOrg/bar", kind: "move", ownerState: "new-organization", renamed: true, order: "transfer-first" },
    ]);
  });

  test("keeps the current name with renaming off", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "Jeffs-Bar", mirror: true, original_url: url("jeff/bar") });
    const result = await preview(scanPlacement([scanRow("jeff/bar", "Mirrors/Jeffs-Bar", "JeffsOrg")]), d.deps, false);
    expect(result.moves).toMatchObject([{ to: "JeffsOrg/Jeffs-Bar", renamed: false }]);
  });

  test("keeps its current name when the source's name is taken, and is blocked when both are", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "Jeffs-Bar", mirror: true, original_url: url("jeff/bar") });
    d.add({ owner: "jeff", name: "bar", mirror: false });
    let result = await preview(scanPlacement([scanRow("jeff/bar", "Mirrors/Jeffs-Bar", "jeff")]), d.deps);
    expect(result.moves).toMatchObject([
      { to: "jeff/Jeffs-Bar", renamed: false, keptNameBecause: "jeff/bar is taken by another repository." },
    ]);

    d.add({ owner: "jeff", name: "jeffs-bar", mirror: false });
    result = await preview(scanPlacement([scanRow("jeff/bar", "Mirrors/Jeffs-Bar", "jeff")]), d.deps);
    expect(result.moves).toEqual([]);
    expect(result.blocked).toMatchObject([{ to: "jeff/bar", reason: "jeff/bar is taken by another repository." }]);
    expect(result.blocked[0].hint).toContain("Rename or remove that repository");
  });

  test("a name that only holds a redirect is free", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "tool", mirror: true, original_url: url("acme/tool") });
    d.redirect("acme/tool", "acme/tool-old");
    d.org("acme");
    const result = await preview(scanPlacement([scanRow("acme/tool", "Mirrors/tool", "acme")]), d.deps);
    expect(result.moves).toMatchObject([{ to: "acme/tool", ownerState: "organization" }]);
  });

  test("two mirrors never get the same place", async () => {
    const d = destination();
    d.add({ owner: "alice", name: "tools", mirror: true, original_url: url("alice/tools") });
    d.add({ owner: "bob", name: "tools", mirror: true, original_url: url("bob/tools") });
    d.add({ owner: "carol", name: "tools", mirror: true, original_url: url("carol/tools") });
    d.add({ owner: "dave", name: "dave-tools", mirror: true, original_url: url("dave/tools") });
    const result = await preview(
      scanPlacement([
        scanRow("alice/tools", "alice/tools", "Mirrors"),
        scanRow("bob/tools", "bob/tools", "Mirrors"),
        scanRow("dave/tools", "dave/dave-tools", "Mirrors"),
      ]),
      d.deps
    );
    expect(result.moves.map((m) => `${m.fullName} -> ${m.to}`)).toEqual([
      "alice/tools -> Mirrors/tools",
      "dave/tools -> Mirrors/dave-tools",
    ]);
    expect(result.moves[1].keptNameBecause).toBe("the mirror of alice/tools is moving to Mirrors/tools.");
    expect(result.blocked).toMatchObject([{ fullName: "bob/tools", reason: "The mirror of alice/tools is moving to Mirrors/tools." }]);
  });

  test("points the record at a copy of the same source already there", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "tool", mirror: true, original_url: url("acme/tool") });
    d.add({ owner: "acme", name: "tool", mirror: true, original_url: url("acme/tool") });
    const result = await preview(scanPlacement([scanRow("acme/tool", "Mirrors/tool", "acme")]), d.deps);
    expect(result.moves).toMatchObject([{ from: "Mirrors/tool", to: "acme/tool", kind: "record" }]);
    expect(result.moves[0].note).toBe("acme/tool is already a mirror of the same repository, so Gitea Mirror switches to it. Mirrors/tool stays on the destination for you to delete.");
  });

  test("a mirror moved by hand only needs its record updated", async () => {
    const d = destination();
    d.add({ owner: "acme", name: "tool", mirror: true, original_url: url("acme/tool") });
    d.redirect("Mirrors/tool", "acme/tool");
    const result = await preview(scanPlacement([scanRow("acme/tool", "Mirrors/tool", "acme")]), d.deps);
    expect(result.moves).toMatchObject([{ from: "Mirrors/tool", to: "acme/tool", kind: "record" }]);
  });

  test("finds a mirror renamed on the destination and moves it from there", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "tool-2", mirror: true, original_url: url("acme/tool") });
    d.redirect("Mirrors/tool", "Mirrors/tool-2");
    const result = await preview(scanPlacement([scanRow("acme/tool", "Mirrors/tool", "acme")]), d.deps);
    expect(result.moves).toMatchObject([{ from: "Mirrors/tool-2", to: "acme/tool", renamed: true }]);
    expect(result.moves[0].note).toBe("Renamed on the destination since it was mirrored (was Mirrors/tool).");
  });

  test("blocks a mirror that is not on the destination", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "tool", mirror: false });
    const result = await preview(scanPlacement([scanRow("acme/tool", "Mirrors/tool", "acme")]), d.deps);
    expect(result.blocked).toMatchObject([{ reason: "The mirror is not on the destination at Mirrors/tool." }]);
    expect(result.blocked[0].hint).toContain("Reconcile with destination");
  });

  test("never moves a mirror into another person's account", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "bar", mirror: true, original_url: url("james/bar") });
    d.user("james");
    const result = await preview(scanPlacement([scanRow("james/bar", "Mirrors/bar", "james")]), d.deps);
    expect(result.blocked).toMatchObject([{ reason: "james is a person's account on the destination, not an organization." }]);
  });

  test("your own account is a fine target", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "dotfiles", mirror: true, original_url: url("me/dotfiles") });
    const result = await preview(scanPlacement([scanRow("me/dotfiles", "Mirrors/dotfiles", "me")]), d.deps);
    expect(result.moves).toMatchObject([{ to: "me/dotfiles", ownerState: "account" }]);
  });

  test("checks what a token that is not an administrator may do", async () => {
    const d = destination();
    d.setAdmin(false);
    d.add({ owner: "Mirrors", name: "a", mirror: true, original_url: url("x/a") });
    d.add({ owner: "Mirrors", name: "b", mirror: true, original_url: url("y/b"), admin: false });
    d.org("x");
    d.org("y");
    d.noCreate("x");
    const result = await preview(
      scanPlacement([scanRow("x/a", "Mirrors/a", "x"), scanRow("y/b", "Mirrors/b", "y")]),
      d.deps
    );
    expect(result.moves).toEqual([]);
    expect(result.blocked.map((b) => b.reason)).toEqual([
      "Your destination account cannot create repositories in x.",
      "Your destination account cannot transfer Mirrors/b: that takes admin rights on the repository.",
    ]);
  });

  test("an owner name the destination would refuse is blocked", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "a", mirror: true, original_url: url("x/a") });
    const result = await preview(scanPlacement([scanRow("x/a", "Mirrors/a", "bad name")]), d.deps);
    expect(result.blocked[0].reason).toBe("bad name is not a valid organization name on the destination.");
  });

  test("renames before the transfer when the current name is taken at the target", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "Jeffs-Bar", mirror: true, original_url: url("jeff/bar") });
    d.add({ owner: "jeff", name: "Jeffs-Bar", mirror: false });
    const result = await preview(scanPlacement([scanRow("jeff/bar", "Mirrors/Jeffs-Bar", "jeff")]), d.deps);
    expect(result.moves).toMatchObject([{ to: "jeff/bar", renamed: true, order: "rename-first" }]);
  });

  test("a lookup failure blocks only that mirror", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "a", mirror: true, original_url: url("x/a") });
    d.add({ owner: "Mirrors", name: "b", mirror: true, original_url: url("x/b") });
    const lookup = d.deps.lookup;
    d.deps.lookup = async (owner, name) => {
      if (name === "a") throw new Error("HTTP 500: Internal Server Error");
      return lookup(owner, name);
    };
    const result = await preview(
      scanPlacement([scanRow("x/a", "Mirrors/a", "x"), scanRow("x/b", "Mirrors/b", "x")]),
      d.deps
    );
    expect(result.moves.map((m) => m.fullName)).toEqual(["x/b"]);
    expect(result.blocked[0].reason).toBe("Could not look it up on the destination: HTTP 500: Internal Server Error");
  });
});

describe.skipIf(!isChild)("previewPlacement blocks with the right advice", () => {
  test("a name the destination keeps for itself", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "a", mirror: true, original_url: url("x/a") });
    const result = await preview(scanPlacement([scanRow("x/a", "Mirrors/a", "api")]), d.deps);
    expect(result.moves).toEqual([]);
    expect(result.blocked[0].reason).toBe("The destination keeps the name api for itself, so no organization can have it.");
  });

  test("suggests the source name only when it is a different name", async () => {
    const d = destination();
    d.add({ owner: "Mirrors", name: "tool", mirror: true, original_url: url("acme/tool") });
    d.add({ owner: "Mirrors", name: "old-docs", mirror: true, original_url: url("acme/docs") });
    d.add({ owner: "acme", name: "tool", mirror: false });
    d.add({ owner: "acme", name: "old-docs", mirror: false });
    const result = await preview(
      scanPlacement([scanRow("acme/tool", "Mirrors/tool", "acme"), scanRow("acme/docs", "Mirrors/old-docs", "acme")]),
      d.deps,
      false
    );
    const hint = (name: string) => result.blocked.find((b) => b.fullName === name)?.hint ?? "";
    expect(hint("acme/docs")).toContain("turn on Use the source name to move it as docs");
    expect(hint("acme/tool")).not.toContain("Use the source name");
  });

  test("a mirror already in your account is recorded as yours", async () => {
    const d = destination();
    d.add({ owner: "me", name: "dotfiles", mirror: true, original_url: url("me/dotfiles") });
    d.redirect("Mirrors/dotfiles", "me/dotfiles");
    const result = await preview(scanPlacement([scanRow("me/dotfiles", "Mirrors/dotfiles", "me")]), d.deps);
    expect(result.moves).toMatchObject([{ kind: "record", ownerState: "account" }]);
  });
});

describe.skipIf(!isChild)("isReservedOwnerName", () => {
  test("follows what each destination refuses", async () => {
    const { isReservedOwnerName } = await import("./mirror-placement");
    expect(isReservedOwnerName("API")).toBe(true);
    expect(isReservedOwnerName("team.keys")).toBe(true);
    expect(isReservedOwnerName("admin", "gitea")).toBe(false);
    expect(isReservedOwnerName("admin", "forgejo")).toBe(true);
    expect(isReservedOwnerName("search")).toBe(false);
  });
});

describe.skipIf(!isChild)("the Configuration page's bar", () => {
  // Opened on single-org, changed to preserve, 4 mirrors now out of place.
  const changed = {
    supported: true,
    outOfPlace: 4,
    baseKey: "single-org|Mirrors",
    summaryKey: "preserve|Mirrors",
    currentKey: "preserve|Mirrors",
    dismissedKey: null,
    saveFailed: false,
    runStartedHere: false,
  };

  test("comes up when a change on the page leaves mirrors out of place", () => {
    expect(placementBarMode(changed)).toBe("prompt");
  });

  test("leaves mirrors that were out of place when the page opened to the card", () => {
    expect(placementBarMode({ ...changed, currentKey: changed.baseKey, summaryKey: changed.baseKey })).toBeNull();
  });

  test("waits for the first summary before it knows the settings the page opened with", () => {
    expect(placementBarMode({ ...changed, baseKey: null })).toBeNull();
  });

  test("waits for the summary of the current settings instead of showing the previous count", () => {
    expect(placementBarMode({ ...changed, summaryKey: "single-org|Mirrors" })).toBeNull();
  });

  test("stays away when nothing is out of place or the destination cannot move mirrors", () => {
    expect(placementBarMode({ ...changed, outOfPlace: 0 })).toBeNull();
    expect(placementBarMode({ ...changed, supported: false })).toBeNull();
  });

  test("says nothing after a failed save, since the server still has the old settings", () => {
    expect(placementBarMode({ ...changed, saveFailed: true })).toBeNull();
  });

  test("Not now puts it away until the next change", () => {
    const dismissed = { ...changed, dismissedKey: changed.currentKey };
    expect(placementBarMode(dismissed)).toBeNull();
    expect(placementBarMode({ ...dismissed, currentKey: "mixed|Mirrors", summaryKey: "mixed|Mirrors" })).toBe("prompt");
  });

  test("follows a move started on the page, whatever the settings say", () => {
    expect(placementBarMode({ ...changed, runStartedHere: true })).toBe("run");
    expect(placementBarMode({ ...changed, outOfPlace: 0, runStartedHere: true })).toBe("run");
  });
});
