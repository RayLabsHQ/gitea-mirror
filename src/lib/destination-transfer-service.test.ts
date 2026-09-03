/**
 * Tests for moving a mirror to another owner (issue #400). The destination
 * is replaced by injected functions, so each test states what sits at the
 * recorded location, what the search finds, what sits under the target and
 * how the transfer answers, then checks what the service records.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Config } from "@/types/config";
import type { Repository } from "@/lib/db/schema";
import type { MoveDeps } from "./destination-transfer-service";
import type { MoveErrorCode } from "./destination-transfer";

const dbUpdateSetCalls: any[] = [];
let selectRows: any[] = [];
const mockDb = {
  select: mock(() => ({
    from: mock(() => ({
      where: mock(() => {
        const rows = selectRows;
        const result: any = Promise.resolve(rows);
        result.orderBy = mock(() => Promise.resolve(rows));
        result.limit = mock(() => Promise.resolve(rows));
        return result;
      }),
    })),
  })),
  update: mock(() => ({
    set: mock((data: any) => {
      dbUpdateSetCalls.push(data);
      return { where: mock(() => Promise.resolve()) };
    }),
  })),
};

mock.module("@/lib/db", () => ({
  db: mockDb,
  users: {},
  configs: {},
  organizations: {},
  mirrorJobs: {},
  repositories: {},
  events: {},
  accounts: {},
  sessions: {},
}));

const mockCreateMirrorJob = mock(() => Promise.resolve("job-id"));
mock.module("@/lib/helpers", () => ({ createMirrorJob: mockCreateMirrorJob }));

mock.module("@/lib/utils/config-encryption", () => ({
  decryptConfigTokens: (config: any) => config,
  encryptConfigTokens: (config: any) => config,
  getDecryptedGitHubToken: (config: any) => config.githubConfig?.token || "",
  getDecryptedGiteaToken: (config: any) => config.giteaConfig?.token || "",
}));

class MockHttpError extends Error {
  constructor(message: string, public status: number, public statusText: string, public response?: string) {
    super(message);
    this.name = "HttpError";
  }
}

const httpGetRoutes: Array<{ matches: (url: string) => boolean; respond: () => any }> = [];
const mockHttpGet = mock(async (url: string) => {
  const route = httpGetRoutes.find((r) => r.matches(url));
  if (!route) throw new MockHttpError(`HTTP 404: ${url}`, 404, "Not Found");
  return route.respond();
});
const mockHttpPost = mock(async (_url: string, body?: any) => ({
  data: { id: 5, username: body?.username },
  status: 201,
  statusText: "Created",
  headers: new Headers(),
}));

mock.module("@/lib/http-client", () => ({
  HttpError: MockHttpError,
  httpRequest: mock(async () => ({ data: {}, status: 200, statusText: "OK", headers: new Headers() })),
  GiteaHttpClient: class {},
  httpGet: mockHttpGet,
  httpPost: mockHttpPost,
  httpPatch: mock(async () => ({ data: {}, status: 200, statusText: "OK", headers: new Headers() })),
  httpPut: mock(async () => ({ data: {}, status: 200, statusText: "OK", headers: new Headers() })),
  httpDelete: mock(async () => ({ data: {}, status: 204, statusText: "No Content", headers: new Headers() })),
}));

const { moveMirror, moveOrganizationMirrors, ensureDestinationOwner } = await import(
  "./destination-transfer-service"
);
const { MoveMirrorError } = await import("./destination-transfer");

const config = {
  userId: "user-1",
  githubConfig: { token: "gh-token", owner: "octocat", mirrorStrategy: "preserve" },
  giteaConfig: {
    url: "https://gitea.example.com",
    token: "gitea-token",
    defaultOwner: "me",
    provider: "gitea",
  },
} as unknown as Partial<Config>;

const pushConfig = {
  ...config,
  giteaConfig: { ...(config.giteaConfig as object), url: "https://github.com", provider: "github" },
} as unknown as Partial<Config>;

function repo(overrides: Record<string, unknown> = {}): Repository {
  return {
    id: "r1",
    userId: "user-1",
    name: "hello",
    fullName: "octocat/hello",
    owner: "octocat",
    organization: null,
    url: "https://github.com/octocat/hello",
    cloneUrl: "https://github.com/octocat/hello.git",
    mirroredLocation: "mirrors/hello",
    status: "mirrored",
    isStarred: false,
    destinationOrg: null,
    sourceProvider: "github",
    sourceUrl: "https://github.com",
    destinationProvider: "gitea",
    destinationUrl: "https://gitea.example.com",
    ...overrides,
  } as unknown as Repository;
}

function info(owner: string, name: string, originalUrl: string | undefined = "https://github.com/octocat/hello.git") {
  return { id: 1, name, owner: { login: owner }, mirror: true, original_url: originalUrl, private: false };
}

/** The destination as a map of "owner/name" to what GET /repos answers, plus what the search and the transfer do. */
function deps(present: Record<string, any>, overrides: Partial<MoveDeps> = {}) {
  const lookups: string[] = [];
  return {
    lookups,
    getRepoInfo: mock(async ({ owner, repoName }: { owner: string; repoName: string }) => {
      lookups.push(`${owner}/${repoName}`);
      const key = Object.keys(present).find((k) => k.toLowerCase() === `${owner}/${repoName}`.toLowerCase());
      return key ? present[key] : null;
    }),
    searchBySource: mock(async () => null),
    ensureOwner: mock(async () => {}),
    transfer: mock(async ({ repoName, newOwner }: { repoName: string; newOwner: string }) => ({
      pending: false,
      repo: info(newOwner, repoName),
    })),
    ...overrides,
  } as MoveDeps & { lookups: string[] };
}

async function expectMoveError(promise: Promise<unknown>, code: MoveErrorCode, status: number) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MoveMirrorError);
  expect((caught as InstanceType<typeof MoveMirrorError>).code).toBe(code);
  expect((caught as InstanceType<typeof MoveMirrorError>).status).toBe(status);
  return caught as InstanceType<typeof MoveMirrorError>;
}

beforeEach(() => {
  dbUpdateSetCalls.length = 0;
  selectRows = [];
  httpGetRoutes.length = 0;
  mockCreateMirrorJob.mockClear();
  mockHttpGet.mockClear();
  mockHttpPost.mockClear();
});

describe("moveMirror", () => {
  test("a row that was never mirrored has nothing to move", async () => {
    const d = deps({});
    const result = await moveMirror({
      userId: "user-1",
      config,
      repository: repo({ mirroredLocation: "" }),
      newOwner: "archive",
      deps: d,
    });

    expect(result.outcome).toBe("not-mirrored");
    expect(d.getRepoInfo).not.toHaveBeenCalled();
    expect(d.transfer).not.toHaveBeenCalled();
    expect(dbUpdateSetCalls).toHaveLength(0);
  });

  test("transfers the mirror at the recorded location and records where it landed", async () => {
    const d = deps({ "mirrors/hello": info("mirrors", "hello") });
    const result = await moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d });

    expect(result).toMatchObject({ outcome: "moved", from: "mirrors/hello", to: "archive/hello" });
    expect(d.lookups).toEqual(["mirrors/hello", "archive/hello"]);
    expect(d.searchBySource).not.toHaveBeenCalled();
    expect(d.ensureOwner).toHaveBeenCalledWith({ config, owner: "archive" });
    expect(d.transfer).toHaveBeenCalledWith({ config, owner: "mirrors", repoName: "hello", newOwner: "archive" });
    expect(dbUpdateSetCalls).toHaveLength(1);
    expect(dbUpdateSetCalls[0]).toMatchObject({ mirroredLocation: "archive/hello" });
    expect(dbUpdateSetCalls[0].status).toBeUndefined();
    expect(mockCreateMirrorJob).toHaveBeenCalledTimes(1);
  });

  test("a failed row is healthy again once its mirror has moved", async () => {
    const d = deps({ "mirrors/hello": info("mirrors", "hello") });
    await moveMirror({ userId: "user-1", config, repository: repo({ status: "failed" }), newOwner: "archive", deps: d });

    expect(dbUpdateSetCalls[0]).toMatchObject({ mirroredLocation: "archive/hello", status: "mirrored", errorMessage: null });
  });

  test("trusts a mirror at the recorded location that reports no source URL", async () => {
    const d = deps({ "mirrors/hello": info("mirrors", "hello", undefined) });
    const result = await moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d });

    expect(result.outcome).toBe("moved");
    expect(d.searchBySource).not.toHaveBeenCalled();
  });

  test("finds a mirror someone moved by hand and transfers it from there", async () => {
    const d = deps(
      { "other-org/hello": info("other-org", "hello") },
      { searchBySource: mock(async () => info("other-org", "hello")) }
    );
    const result = await moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d });

    expect(result).toMatchObject({ outcome: "moved", from: "mirrors/hello", to: "archive/hello" });
    expect(d.transfer).toHaveBeenCalledWith({ config, owner: "other-org", repoName: "hello", newOwner: "archive" });
    expect(dbUpdateSetCalls[0]).toMatchObject({ mirroredLocation: "archive/hello" });
  });

  test("a different repository at the recorded location does not count as ours", async () => {
    const d = deps({ "mirrors/hello": info("mirrors", "hello", "https://github.com/other/hello.git") });
    await expectMoveError(
      moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d }),
      "not-on-destination",
      409
    );

    expect(d.searchBySource).toHaveBeenCalledTimes(1);
    expect(d.transfer).not.toHaveBeenCalled();
  });

  test("refuses when the mirror is nowhere on the destination", async () => {
    const d = deps({});
    const error = await expectMoveError(
      moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d }),
      "not-on-destination",
      409
    );

    expect(error.message).toContain("Reconcile");
    expect(d.transfer).not.toHaveBeenCalled();
    expect(dbUpdateSetCalls).toHaveLength(0);
  });

  test("only records when the mirror is already under the new owner", async () => {
    const d = deps({ "Archive/hello": info("Archive", "hello") });
    const result = await moveMirror({
      userId: "user-1",
      config,
      repository: repo({ mirroredLocation: "Archive/hello" }),
      newOwner: "archive",
      deps: d,
    });

    expect(result).toMatchObject({ outcome: "recorded", to: "Archive/hello" });
    expect(d.transfer).not.toHaveBeenCalled();
    expect(dbUpdateSetCalls).toHaveLength(0);
  });

  test("points the row at a same-source mirror that already sits under the target", async () => {
    const d = deps({ "mirrors/hello": info("mirrors", "hello"), "archive/hello": info("archive", "hello") });
    const result = await moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d });

    expect(result).toMatchObject({ outcome: "recorded", from: "mirrors/hello", to: "archive/hello" });
    expect(result.message).toContain("left alone");
    expect(d.transfer).not.toHaveBeenCalled();
    expect(dbUpdateSetCalls[0]).toMatchObject({ mirroredLocation: "archive/hello" });
  });

  test("refuses to move onto a different repository of the same name", async () => {
    const d = deps({
      "mirrors/hello": info("mirrors", "hello"),
      "archive/hello": info("archive", "hello", "https://github.com/other/hello.git"),
    });
    await expectMoveError(
      moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d }),
      "name-taken",
      409
    );

    expect(d.transfer).not.toHaveBeenCalled();
    expect(dbUpdateSetCalls).toHaveLength(0);
  });

  test("a pending transfer leaves the recorded location alone", async () => {
    const d = deps(
      { "mirrors/hello": info("mirrors", "hello") },
      { transfer: mock(async () => ({ pending: true, repo: info("mirrors", "hello") })) }
    );
    const result = await moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d });

    expect(result).toMatchObject({ outcome: "pending", from: "mirrors/hello", to: "archive/hello" });
    expect(result.message).toContain("accept");
    expect(dbUpdateSetCalls).toHaveLength(0);
    expect(mockCreateMirrorJob).toHaveBeenCalledTimes(1);
  });

  test("maps the destination's answers to reasons a user can act on", async () => {
    const cases: Array<[number, MoveErrorCode, number]> = [
      [409, "transfer-pending", 409],
      [422, "name-taken", 409],
      [403, "forbidden", 403],
      [404, "not-on-destination", 409],
      [500, "destination-error", 502],
    ];
    for (const [httpStatus, code, status] of cases) {
      const d = deps(
        { "mirrors/hello": info("mirrors", "hello") },
        {
          transfer: mock(async () => {
            throw new MockHttpError(`HTTP ${httpStatus}`, httpStatus, "Error");
          }),
        }
      );
      await expectMoveError(
        moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d }),
        code,
        status
      );
    }
    expect(dbUpdateSetCalls).toHaveLength(0);
  });

  test("refuses push destinations before touching anything", async () => {
    const d = deps({ "mirrors/hello": info("mirrors", "hello") });
    await expectMoveError(
      moveMirror({
        userId: "user-1",
        config: pushConfig,
        repository: repo({ destinationProvider: "github", destinationUrl: "https://github.com" }),
        newOwner: "archive",
        deps: d,
      }),
      "destination-unsupported",
      400
    );
    expect(d.getRepoInfo).not.toHaveBeenCalled();
  });

  test("refuses a row that was mirrored to another host", async () => {
    const d = deps({ "mirrors/hello": info("mirrors", "hello") });
    await expectMoveError(
      moveMirror({
        userId: "user-1",
        config,
        repository: repo({ destinationUrl: "https://other.example.com" }),
        newOwner: "archive",
        deps: d,
      }),
      "destination-mismatch",
      409
    );
    expect(d.getRepoInfo).not.toHaveBeenCalled();
  });

  test("a target owner that cannot be prepared stops the move", async () => {
    const d = deps(
      { "mirrors/hello": info("mirrors", "hello") },
      {
        ensureOwner: mock(async () => {
          throw new Error("Permission denied: cannot create organizations");
        }),
      }
    );
    const error = await expectMoveError(
      moveMirror({ userId: "user-1", config, repository: repo(), newOwner: "archive", deps: d }),
      "destination-error",
      502
    );
    expect(error.message).toContain("Permission denied");
    expect(d.transfer).not.toHaveBeenCalled();
  });
});

describe("ensureDestinationOwner", () => {
  test("the account itself always exists", async () => {
    await ensureDestinationOwner({ config, owner: "Me" });
    expect(mockHttpGet).not.toHaveBeenCalled();
    expect(mockHttpPost).not.toHaveBeenCalled();
  });

  test("an existing user or organization is left alone", async () => {
    httpGetRoutes.push({
      matches: (url) => url.endsWith("/api/v1/users/archive"),
      respond: () => ({ data: { id: 3, login: "archive" }, status: 200, statusText: "OK", headers: new Headers() }),
    });
    await ensureDestinationOwner({ config, owner: "archive" });
    expect(mockHttpGet).toHaveBeenCalledTimes(1);
    expect(mockHttpPost).not.toHaveBeenCalled();
  });

  test("an unknown name is created as an organization, the way a mirror run does", async () => {
    httpGetRoutes.push({
      matches: (url) => url.endsWith("/api/v1/user"),
      respond: () => ({ data: { id: 1, login: "me", username: "me" }, status: 200, statusText: "OK", headers: new Headers() }),
    });
    await ensureDestinationOwner({ config, owner: "archive" });

    const orgCreate = mockHttpPost.mock.calls.find((call) => String(call[0]).endsWith("/api/v1/orgs"));
    expect(orgCreate).toBeDefined();
    expect((orgCreate as any[])[1]?.username).toBe("archive");
  });
});

describe("moveOrganizationMirrors", () => {
  const orgRepo = (id: string, name: string, overrides: Record<string, unknown> = {}) =>
    repo({
      id,
      name,
      fullName: `acme/${name}`,
      organization: "acme",
      url: `https://github.com/acme/${name}`,
      cloneUrl: `https://github.com/acme/${name}.git`,
      mirroredLocation: `acme/${name}`,
      ...overrides,
    });
  const orgInfo = (owner: string, name: string) => info(owner, name, `https://github.com/acme/${name}.git`);

  test("a dry run returns the plan and moves nothing", async () => {
    selectRows = [
      orgRepo("a", "api"),
      orgRepo("b", "custom", { destinationOrg: "elsewhere" }),
      orgRepo("c", "new", { mirroredLocation: "" }),
    ];
    const d = deps({ "acme/api": orgInfo("acme", "api") });
    const result = await moveOrganizationMirrors({
      userId: "user-1",
      config,
      organization: { id: "o1", name: "acme" },
      destinationOrg: "archive",
      dryRun: true,
      deps: d,
      strategyOwnerFor: (row) => row.organization ?? "me",
    });

    expect(result.dryRun).toBe(true);
    expect(result.plan.moves).toEqual([{ id: "a", fullName: "acme/api", from: "acme/api", to: "archive/api" }]);
    expect(result.plan.skipped.map((s) => s.fullName)).toEqual(["acme/custom", "acme/new"]);
    expect(d.getRepoInfo).not.toHaveBeenCalled();
    expect(d.transfer).not.toHaveBeenCalled();
    expect(mockCreateMirrorJob).not.toHaveBeenCalled();
  });

  test("moves what it can, reports what it cannot, and logs a summary", async () => {
    selectRows = [orgRepo("a", "api"), orgRepo("d", "locked")];
    const d = deps(
      { "acme/api": orgInfo("acme", "api"), "acme/locked": orgInfo("acme", "locked") },
      {
        transfer: mock(async ({ repoName, newOwner }: { repoName: string; newOwner: string }) => {
          if (repoName === "locked") throw new MockHttpError("HTTP 403", 403, "Forbidden");
          return { pending: false, repo: orgInfo(newOwner, repoName) };
        }),
      }
    );
    const result = await moveOrganizationMirrors({
      userId: "user-1",
      config,
      organization: { id: "o1", name: "acme" },
      destinationOrg: "archive",
      dryRun: false,
      deps: d,
      strategyOwnerFor: (row) => row.organization ?? "me",
    });

    expect(result.moved).toEqual([{ fullName: "acme/api", from: "acme/api", to: "archive/api" }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].fullName).toBe("acme/locked");
    expect(result.failed[0].error).toContain("not allowed");
    expect(dbUpdateSetCalls).toEqual([expect.objectContaining({ mirroredLocation: "archive/api" })]);

    const summary = mockCreateMirrorJob.mock.calls.map((call: any[]) => call[0]).find((job: any) => job.organizationName === "acme");
    expect(summary).toBeDefined();
    expect((summary as any).details).toContain("Moved 1");
    expect((summary as any).details).toContain("failed 1");
  });

  test("removing the override sends rows back to where the strategy puts them", async () => {
    selectRows = [orgRepo("a", "api", { mirroredLocation: "old/api" }), orgRepo("e", "here")];
    const d = deps({ "old/api": orgInfo("old", "api"), "acme/here": orgInfo("acme", "here") });
    const result = await moveOrganizationMirrors({
      userId: "user-1",
      config,
      organization: { id: "o1", name: "acme" },
      destinationOrg: null,
      dryRun: false,
      deps: d,
      strategyOwnerFor: (row) => row.organization ?? "me",
    });

    expect(result.plan.moves.map((m) => m.to)).toEqual(["acme/api"]);
    expect(result.plan.skipped).toEqual([{ fullName: "acme/here", reason: "already under acme" }]);
    expect(result.moved).toEqual([{ fullName: "acme/api", from: "old/api", to: "acme/api" }]);
    expect(d.transfer).toHaveBeenCalledWith({ config, owner: "old", repoName: "api", newOwner: "acme" });
  });
});
