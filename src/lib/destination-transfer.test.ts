/**
 * Unit tests for the pure decisions behind moving a mirror (issue #400):
 * reading a recorded location, trusting what sits there, and planning an
 * organization-wide move.
 */

import { describe, test, expect } from "bun:test";
import {
  OWNER_NAME_PATTERN,
  isRecordedMirror,
  ownerLogin,
  planOrganizationMove,
  splitLocation,
} from "./destination-transfer";

describe("splitLocation", () => {
  test("reads owner and name, trimming whitespace", () => {
    expect(splitLocation(" mirrors/hello ")).toEqual({ owner: "mirrors", name: "hello" });
  });

  test("keeps everything after the first slash as the name", () => {
    expect(splitLocation("org/nested/name")).toEqual({ owner: "org", name: "nested/name" });
  });

  test("rejects blank, owner-only and name-only values", () => {
    expect(splitLocation("")).toBeNull();
    expect(splitLocation(null)).toBeNull();
    expect(splitLocation("hello")).toBeNull();
    expect(splitLocation("/hello")).toBeNull();
    expect(splitLocation("mirrors/")).toBeNull();
  });
});

describe("ownerLogin", () => {
  test("accepts both shapes Gitea uses for the owner", () => {
    expect(ownerLogin({ owner: "archive" } as any)).toBe("archive");
    expect(ownerLogin({ owner: { login: "archive" } } as any)).toBe("archive");
    expect(ownerLogin(null)).toBe("");
  });
});

describe("isRecordedMirror", () => {
  const source = "https://github.com/octocat/hello.git";

  test("is false for nothing and for a native repository", () => {
    expect(isRecordedMirror(null, source)).toBe(false);
    expect(isRecordedMirror({ mirror: false, original_url: source } as any, source)).toBe(false);
  });

  test("trusts a mirror at our own recorded location when the server gives no source", () => {
    expect(isRecordedMirror({ mirror: true } as any, source)).toBe(true);
  });

  test("accepts the same source in any spelling and rejects another one", () => {
    expect(isRecordedMirror({ mirror: true, original_url: "https://GitHub.com/octocat/hello" } as any, source)).toBe(true);
    expect(isRecordedMirror({ mirror: true, original_url: "https://github.com/other/hello.git" } as any, source)).toBe(false);
  });
});

describe("OWNER_NAME_PATTERN", () => {
  test("accepts what Gitea accepts and nothing that could change the URL", () => {
    for (const ok of ["archive", "my-org", "a.b_c", "Org2"]) expect(OWNER_NAME_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "a/b", ".hidden", "with space", "a?b", "-lead"]) expect(OWNER_NAME_PATTERN.test(bad)).toBe(false);
  });
});

describe("planOrganizationMove", () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: String(overrides.fullName),
    fullName: "acme/x",
    isStarred: false,
    destinationOrg: null,
    mirroredLocation: "acme/x",
    status: "mirrored",
    ...overrides,
  }) as any;

  test("moves mirrored rows and explains every row it leaves alone", () => {
    const plan = planOrganizationMove({
      rows: [
        row({ fullName: "acme/api", mirroredLocation: "acme/api" }),
        row({ fullName: "acme/renamed", mirroredLocation: "acme/renamed-2" }),
        row({ fullName: "acme/starred", isStarred: true }),
        row({ fullName: "acme/custom", destinationOrg: "elsewhere" }),
        row({ fullName: "acme/new", mirroredLocation: "" }),
        row({ fullName: "acme/busy", status: "syncing" }),
        row({ fullName: "acme/there", mirroredLocation: "Archive/there" }),
      ],
      targetOwnerFor: () => "archive",
    });

    expect(plan.moves).toEqual([
      { id: "acme/api", fullName: "acme/api", from: "acme/api", to: "archive/api" },
      // The destination name is kept, suffix and all; only the owner changes.
      { id: "acme/renamed", fullName: "acme/renamed", from: "acme/renamed-2", to: "archive/renamed-2" },
    ]);
    expect(plan.skipped).toEqual([
      { fullName: "acme/starred", reason: "starred repositories keep their own destination" },
      { fullName: "acme/custom", reason: "has its own destination (elsewhere)" },
      { fullName: "acme/new", reason: "not mirrored yet" },
      { fullName: "acme/busy", reason: "a syncing run is in progress" },
      { fullName: "acme/there", reason: "already under Archive" },
    ]);
  });

  test("asks the resolver per row, so removing the override can send rows to different owners", () => {
    const plan = planOrganizationMove({
      rows: [
        row({ fullName: "acme/a", mirroredLocation: "old/a" }),
        row({ fullName: "acme/b", mirroredLocation: "old/b" }),
        row({ fullName: "acme/c", mirroredLocation: "old/c" }),
      ],
      targetOwnerFor: (r) => (r.fullName === "acme/b" ? "me" : r.fullName === "acme/c" ? "" : "acme"),
    });

    expect(plan.moves.map((m) => m.to)).toEqual(["acme/a", "me/b"]);
    expect(plan.skipped).toEqual([
      { fullName: "acme/c", reason: "no destination owner could be determined" },
    ]);
  });
});
