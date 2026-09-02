/**
 * Unit tests for the pure reconcile decisions (issue #284): which
 * destination repositories are ours, which of those the database knows
 * about, and which rows claim a mirror the destination no longer has.
 */

import { describe, test, expect } from "bun:test";
import {
  classifyDestinationRepos,
  collectDestinationOwners,
  expectedLocation,
  knownSourceHosts,
  parseRepoUrl,
  splitRowsByDestination,
  type DestinationRepo,
  type TrackedRepositoryRow,
} from "./destination-reconcile";

function destinationRepo(overrides: Partial<DestinationRepo> & { fullName: string }): DestinationRepo {
  const [owner, name] = overrides.fullName.split("/");
  return {
    owner,
    name,
    mirror: true,
    originalUrl: `https://github.com/${overrides.fullName}.git`,
    isPrivate: false,
    isArchived: false,
    description: null,
    defaultBranch: "main",
    size: 0,
    htmlUrl: `https://gitea.example.com/${overrides.fullName}`,
    cloneUrl: `https://gitea.example.com/${overrides.fullName}.git`,
    language: null,
    hasIssues: false,
    updatedAt: null,
    mirrorUpdated: null,
    ...overrides,
  };
}

function row(overrides: Partial<TrackedRepositoryRow> & { fullName: string }): TrackedRepositoryRow {
  const name = overrides.fullName.split("/").pop() ?? overrides.fullName;
  return {
    id: overrides.fullName,
    name,
    cloneUrl: `https://github.com/${overrides.fullName}.git`,
    mirroredLocation: null,
    status: "mirrored",
    ...overrides,
  };
}

describe("parseRepoUrl", () => {
  test("reads host and path from https clone URLs, dropping .git", () => {
    expect(parseRepoUrl("https://github.com/octocat/Hello-World.git")).toEqual({
      host: "github.com",
      path: "octocat/Hello-World",
      owner: "octocat",
      name: "Hello-World",
    });
  });

  test("keeps GitLab subgroups in the owner", () => {
    expect(parseRepoUrl("https://gitlab.com/group/sub/project.git")).toEqual({
      host: "gitlab.com",
      path: "group/sub/project",
      owner: "group/sub",
      name: "project",
    });
  });

  test("handles self hosted Gitea URLs with a port and no suffix", () => {
    expect(parseRepoUrl("http://gitea.lan:3000/team/tool")).toMatchObject({
      host: "gitea.lan:3000",
      path: "team/tool",
    });
  });

  test("strips credentials, query and fragment", () => {
    expect(parseRepoUrl("https://user:token@github.com/o/r.git?x=1#top")).toMatchObject({
      host: "github.com",
      path: "o/r",
    });
  });

  test("accepts the scp style ssh form", () => {
    expect(parseRepoUrl("git@github.com:octocat/Hello-World.git")).toMatchObject({
      host: "github.com",
      path: "octocat/Hello-World",
    });
  });

  test("rejects empty and non repository URLs", () => {
    expect(parseRepoUrl("")).toBeNull();
    expect(parseRepoUrl("   ")).toBeNull();
    expect(parseRepoUrl("https://github.com/")).toBeNull();
    expect(parseRepoUrl("https://github.com/only-owner")).toBeNull();
    expect(parseRepoUrl("not a url")).toBeNull();
  });
});

describe("knownSourceHosts", () => {
  test("includes the source, the API host with and without api., and clone hosts", () => {
    const hosts = knownSourceHosts({
      sourceUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      cloneUrls: ["https://git.internal:8080/team/repo.git", null, ""],
    });
    expect([...hosts].sort()).toEqual(["api.github.com", "git.internal:8080", "github.com"]);
  });

  test("a GitHub Enterprise API host counts as a clone host", () => {
    const hosts = knownSourceHosts({
      sourceUrl: "https://github.com",
      apiUrl: "https://ghe.example.com/api/v3",
      cloneUrls: [],
    });
    expect(hosts.has("ghe.example.com")).toBeTrue();
  });
});

describe("classifyDestinationRepos", () => {
  const knownHosts = new Set(["github.com"]);

  test("a mirror of the source with no row is untracked", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [destinationRepo({ fullName: "mirrors/hello" })],
      rows: [],
      knownHosts,
    });
    expect(result.untracked.map((r) => r.fullName)).toEqual(["mirrors/hello"]);
    expect(result.notManaged).toEqual([]);
  });

  test("a native repository is reported as not managed and never untracked", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [destinationRepo({ fullName: "me/notes", mirror: false, originalUrl: "" })],
      rows: [],
      knownHosts,
    });
    expect(result.untracked).toEqual([]);
    expect(result.notManaged).toEqual([{ location: "me/notes", reason: "not a mirror" }]);
  });

  test("a mirror of another host is reported with its host", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [
        destinationRepo({ fullName: "mirrors/other", originalUrl: "https://codeberg.org/x/other.git" }),
      ],
      rows: [],
      knownHosts,
    });
    expect(result.untracked).toEqual([]);
    expect(result.notManaged).toEqual([{ location: "mirrors/other", reason: "mirror of codeberg.org" }]);
  });

  test("a mirror without a usable original URL is not managed", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [destinationRepo({ fullName: "mirrors/blank", originalUrl: "" })],
      rows: [],
      knownHosts,
    });
    expect(result.untracked).toEqual([]);
    expect(result.notManaged[0].reason).toBe("mirror without a source URL");
  });

  test("matches a row by its recorded mirrored location, regardless of case", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [destinationRepo({ fullName: "Mirrors/Hello" })],
      rows: [row({ fullName: "octocat/hello", mirroredLocation: "mirrors/hello" })],
      knownHosts,
    });
    expect(result.untracked).toEqual([]);
    expect(result.trackedLocations.has("mirrors/hello")).toBeTrue();
    expect(result.matchedRowIds.has("octocat/hello")).toBeTrue();
    expect(result.unmatchedMirroredRows).toEqual([]);
  });

  test("matches a row by clone URL when the recorded location is stale", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [
        destinationRepo({ fullName: "moved/hello", originalUrl: "https://github.com/octocat/hello.git" }),
      ],
      rows: [row({ fullName: "octocat/hello", mirroredLocation: "old-org/hello" })],
      knownHosts,
    });
    expect(result.untracked).toEqual([]);
    expect(result.matchedRowIds.has("octocat/hello")).toBeTrue();
  });

  test("matches a row by the source path in its full name", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [
        destinationRepo({ fullName: "mirrors/hello", originalUrl: "https://github.com/OctoCat/Hello" }),
      ],
      rows: [row({ fullName: "octocat/hello", cloneUrl: "" })],
      knownHosts,
    });
    expect(result.untracked).toEqual([]);
    expect(result.matchedRowIds.has("octocat/hello")).toBeTrue();
  });

  test("rows that say mirrored but matched nothing are candidates for the missing check", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [],
      rows: [
        row({ fullName: "octocat/gone", status: "mirrored", mirroredLocation: "mirrors/gone" }),
        row({ fullName: "octocat/synced", status: "synced" }),
        row({ fullName: "octocat/new", status: "imported" }),
        row({ fullName: "octocat/broken", status: "failed", mirroredLocation: "mirrors/broken" }),
      ],
      knownHosts,
    });
    expect(result.unmatchedMirroredRows.map((r) => r.fullName)).toEqual([
      "octocat/gone",
      "octocat/synced",
    ]);
  });

  test("mixed listing sorts every repository into exactly one group", () => {
    const result = classifyDestinationRepos({
      destinationRepos: [
        destinationRepo({ fullName: "mirrors/tracked" }),
        destinationRepo({ fullName: "mirrors/orphan" }),
        destinationRepo({ fullName: "me/native", mirror: false, originalUrl: "" }),
        destinationRepo({ fullName: "mirrors/foreign", originalUrl: "https://gitlab.com/a/b.git" }),
      ],
      rows: [row({ fullName: "octocat/tracked", mirroredLocation: "mirrors/tracked" })],
      knownHosts,
    });
    expect(result.untracked.map((r) => r.fullName)).toEqual(["mirrors/orphan"]);
    expect(result.notManaged.map((r) => r.location).sort()).toEqual(["me/native", "mirrors/foreign"]);
    expect([...result.trackedLocations]).toEqual(["mirrors/tracked"]);
  });
});

describe("expectedLocation", () => {
  test("prefers the recorded mirrored location", () => {
    expect(expectedLocation({ name: "hello", mirroredLocation: "mirrors/hello" }, "fallback")).toEqual({
      owner: "mirrors",
      name: "hello",
      location: "mirrors/hello",
    });
  });

  test("falls back to the resolved owner and the row name", () => {
    expect(expectedLocation({ name: "hello", mirroredLocation: "" }, "octo-mirrors")).toEqual({
      owner: "octo-mirrors",
      name: "hello",
      location: "octo-mirrors/hello",
    });
    expect(expectedLocation({ name: "hello", mirroredLocation: "/" }, "owner").location).toBe("owner/hello");
  });
});

describe("collectDestinationOwners", () => {
  test("deduplicates without regard to case and drops blanks and paths", () => {
    expect(
      collectDestinationOwners(["Mirrors", "mirrors", " starred ", "", null, undefined, "org/repo", "user"])
    ).toEqual(["Mirrors", "starred", "user"]);
  });
});

describe("splitRowsByDestination", () => {
  const row = (id: string, extra: Partial<TrackedRepositoryRow> = {}): TrackedRepositoryRow => ({
    id,
    name: id,
    fullName: `octo/${id}`,
    cloneUrl: `https://github.com/octo/${id}.git`,
    mirroredLocation: `mirror-org/${id}`,
    status: "mirrored",
    ...extra,
  });
  const gitea = { provider: "gitea" as const, url: "http://gitea.local:3000" };

  test("keeps rows recorded on the configured destination or with no recorded URL, sets the rest aside", () => {
    const { here, elsewhere } = splitRowsByDestination(
      [
        row("same", { destinationProvider: "gitea", destinationUrl: "http://gitea.local:3000" }),
        row("legacy", { destinationProvider: "gitea", destinationUrl: null }),
        row("pushed", { destinationProvider: "gitlab", destinationUrl: "https://gitlab.com" }),
        row("other-gitea", { destinationProvider: "gitea", destinationUrl: "https://try.gitea.io" }),
      ],
      gitea
    );
    expect(here.map((r) => r.id)).toEqual(["same", "legacy"]);
    expect(elsewhere.map((r) => r.id)).toEqual(["pushed", "other-gitea"]);
  });
});
