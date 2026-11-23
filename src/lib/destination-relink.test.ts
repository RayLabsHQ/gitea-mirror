import { describe, expect, test } from "bun:test";
import type { Repository } from "@/lib/db/schema";
import type { GiteaRepoInfo } from "@/lib/gitea-enhanced";
import { ensureRepositoryOnConfiguredDestination, type RelinkDependencies } from "./destination-relink";

const OLD_URL = "https://git-old.example.com";
const NEW_URL = "https://git.example.com";
const CLONE_URL = "https://github.com/octo/app.git";

function row(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-1",
    name: "app",
    fullName: "octo/app",
    cloneUrl: CLONE_URL,
    url: "https://github.com/octo/app",
    mirroredLocation: "octo/app",
    status: "failed",
    destinationProvider: "gitea",
    destinationUrl: OLD_URL,
    ...overrides,
  } as Repository;
}

function config(url = NEW_URL, provider = "gitea") {
  return { userId: "user-1", giteaConfig: { url, provider, defaultOwner: "me", token: "t" } } as any;
}

function mirrorAt(
  owner: string,
  name: string,
  originalUrl: string,
  { mirror = true, push = true }: { mirror?: boolean; push?: boolean } = {}
): GiteaRepoInfo {
  return {
    id: 1,
    name,
    owner: { login: owner },
    mirror,
    private: false,
    original_url: originalUrl,
    permissions: { admin: false, push, pull: true },
  };
}

/** Counts strategy owner lookups. */
function owner(name: string) {
  const calls: string[] = [];
  const resolve = () => {
    calls.push(name);
    return name;
  };
  return { resolve, calls };
}

/**
 * The configured destination, given as a map of `owner/name` to what the
 * API returns for it, or an Error to throw for that lookup.
 */
function destination(repos: Record<string, GiteaRepoInfo | Error>) {
  const lookups: string[] = [];
  const saved: Array<{ id: string; columns: unknown }> = [];
  const deps: RelinkDependencies = {
    getRepoInfo: async ({ owner, repoName }) => {
      const key = `${owner}/${repoName}`;
      lookups.push(key);
      const answer = repos[key];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
    saveDestination: async (id, columns) => {
      saved.push({ id, columns });
    },
  };
  return { deps, lookups, saved };
}

const REFUSAL = "but the configured destination is";

describe("ensureRepositoryOnConfiguredDestination", () => {
  test("does nothing when the row is recorded on the configured destination", async () => {
    const { deps, lookups, saved } = destination({});
    const relinked = await ensureRepositoryOnConfiguredDestination(
      { repository: row({ destinationUrl: `${NEW_URL}/` }), config: config(), resolveOwner: () => "octo" },
      deps
    );
    expect(relinked).toBeNull();
    expect(lookups).toEqual([]);
    expect(saved).toEqual([]);
  });

  test("repoints a row whose writable mirror is at the recorded location, without resolving the owner", async () => {
    const { deps, lookups, saved } = destination({ "octo/app": mirrorAt("octo", "app", CLONE_URL) });
    const strategy = owner("mirrors");
    const repository = row();
    const relinked = await ensureRepositoryOnConfiguredDestination(
      { repository, config: config(), resolveOwner: strategy.resolve },
      deps
    );
    expect(relinked).toEqual({ owner: "octo", repoName: "app" });
    expect(lookups).toEqual(["octo/app"]);
    expect(strategy.calls).toEqual([]);
    // Where the row points and nothing else: updatedAt is left for the in-flight claim.
    expect(saved).toEqual([
      {
        id: "repo-1",
        columns: { destinationProvider: "gitea", destinationUrl: NEW_URL, mirroredLocation: "octo/app" },
      },
    ]);
    expect(repository.destinationUrl).toBe(NEW_URL);
  });

  test("records the verified location when the recorded one holds a mirror it rejected", async () => {
    const { deps, lookups, saved } = destination({
      "octo/app": mirrorAt("octo", "app", "https://github.com/someone-else/app.git"),
      "mirrors/app": mirrorAt("mirrors", "app", CLONE_URL),
    });
    const repository = row();
    const relinked = await ensureRepositoryOnConfiguredDestination(
      { repository, config: config(), resolveOwner: () => "mirrors" },
      deps
    );
    expect(relinked).toEqual({ owner: "mirrors", repoName: "app" });
    expect(lookups).toEqual(["octo/app", "mirrors/app"]);
    expect(saved[0].columns).toMatchObject({ mirroredLocation: "mirrors/app" });
    // The sync tries the recorded location first, so it now lands on the verified mirror.
    expect(repository.mirroredLocation).toBe("mirrors/app");
  });

  test("refuses a mirror when the destination reports no permissions for the token", async () => {
    const info = mirrorAt("octo", "app", CLONE_URL);
    delete info.permissions;
    const { deps, saved } = destination({ "octo/app": info });
    await expect(
      ensureRepositoryOnConfiguredDestination(
        { repository: row(), config: config(), resolveOwner: () => "octo" },
        deps
      )
    ).rejects.toThrow(REFUSAL);
    expect(saved).toEqual([]);
  });

  test("repoints a row whose mirror is where the strategy puts it when no location was recorded", async () => {
    const { deps, lookups, saved } = destination({ "mirrors/app": mirrorAt("mirrors", "app", CLONE_URL) });
    const relinked = await ensureRepositoryOnConfiguredDestination(
      { repository: row({ mirroredLocation: "" }), config: config(), resolveOwner: () => "mirrors" },
      deps
    );
    expect(relinked).toEqual({ owner: "mirrors", repoName: "app" });
    expect(lookups).toEqual(["mirrors/app"]);
    expect(saved).toHaveLength(1);
  });

  test("probes at most the recorded and the expected location", async () => {
    const { deps, lookups, saved } = destination({});
    await expect(
      ensureRepositoryOnConfiguredDestination(
        { repository: row(), config: config(), resolveOwner: () => "mirrors" },
        deps
      )
    ).rejects.toThrow(`mirrored to Gitea (${OLD_URL}) ${REFUSAL}`);
    expect(lookups).toEqual(["octo/app", "mirrors/app"]);
    expect(saved).toEqual([]);
  });

  test("refuses a mirror of the same source the token cannot push to, such as another account's", async () => {
    const { deps, saved } = destination({
      "octo/app": mirrorAt("octo", "app", CLONE_URL, { push: false }),
    });
    const repository = row();
    await expect(
      ensureRepositoryOnConfiguredDestination(
        { repository, config: config(), resolveOwner: () => "octo" },
        deps
      )
    ).rejects.toThrow(REFUSAL);
    expect(saved).toEqual([]);
    expect(repository.destinationUrl).toBe(OLD_URL);
  });

  test("refuses a repository that is not a mirror", async () => {
    const { deps, saved } = destination({
      "octo/app": mirrorAt("octo", "app", CLONE_URL, { mirror: false }),
    });
    await expect(
      ensureRepositoryOnConfiguredDestination(
        { repository: row(), config: config(), resolveOwner: () => "octo" },
        deps
      )
    ).rejects.toThrow(REFUSAL);
    expect(saved).toEqual([]);
  });

  test("refuses a mirror of another source", async () => {
    const { deps, saved } = destination({
      "octo/app": mirrorAt("octo", "app", "https://github.com/someone-else/app.git"),
    });
    await expect(
      ensureRepositoryOnConfiguredDestination(
        { repository: row(), config: config(), resolveOwner: () => "octo" },
        deps
      )
    ).rejects.toThrow(REFUSAL);
    expect(saved).toEqual([]);
  });

  test("never relinks across a push target", async () => {
    const { deps, lookups } = destination({ "octo/app": mirrorAt("octo", "app", CLONE_URL) });
    await expect(
      ensureRepositoryOnConfiguredDestination(
        {
          repository: row({ destinationProvider: "github", destinationUrl: "https://github.com" }),
          config: config(),
          resolveOwner: () => "octo",
        },
        deps
      )
    ).rejects.toThrow(REFUSAL);
    expect(lookups).toEqual([]);
  });

  test("reports a destination it could not ask instead of the remove-and-mirror advice", async () => {
    const { deps, saved } = destination({ "octo/app": new Error("GET -> 401 Unauthorized") });
    const promise = ensureRepositoryOnConfiguredDestination(
      { repository: row(), config: config(), resolveOwner: () => "octo" },
      deps
    );
    await expect(promise).rejects.toThrow(
      `Gitea (${NEW_URL}) could not be checked for its mirror: GET -> 401 Unauthorized`
    );
    await expect(promise).rejects.not.toThrow("remove the repository");
    expect(saved).toEqual([]);
  });

  test("still relinks when one location fails but the other holds the mirror", async () => {
    const { deps, saved } = destination({
      "octo/app": new Error("timeout"),
      "mirrors/app": mirrorAt("mirrors", "app", CLONE_URL),
    });
    const relinked = await ensureRepositoryOnConfiguredDestination(
      { repository: row(), config: config(), resolveOwner: () => "mirrors" },
      deps
    );
    expect(relinked).toEqual({ owner: "mirrors", repoName: "app" });
    expect(saved).toHaveLength(1);
  });

  test("propagates a failed save instead of syncing a row it could not repoint", async () => {
    const { deps } = destination({ "octo/app": mirrorAt("octo", "app", CLONE_URL) });
    deps.saveDestination = async () => {
      throw new Error("database is locked");
    };
    const repository = row();
    await expect(
      ensureRepositoryOnConfiguredDestination(
        { repository, config: config(), resolveOwner: () => "octo" },
        deps
      )
    ).rejects.toThrow("database is locked");
    expect(repository.destinationUrl).toBe(OLD_URL);
  });
});
