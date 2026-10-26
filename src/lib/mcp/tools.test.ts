import { describe, expect, test } from "bun:test";
import { API_KEY, toolSession } from "./test-helpers";

const repo = (id: string, fullName: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: fullName.split("/").pop(),
  fullName,
  owner: fullName.split("/")[0],
  status,
  lastMirrored: null,
  mirroredLocation: "",
  errorMessage: null,
  ...extra,
});

const REPOSITORIES = [
  repo("r1", "octocat/hello-world", "mirrored", { mirroredLocation: "mirrors/hello-world" }),
  repo("r2", "octocat/broken", "failed", { errorMessage: "clone failed: authentication required" }),
  repo("r3", "acme/tools", "imported"),
  repo("r4", "acme/widget", "failed", { errorMessage: "x".repeat(2000) }),
];

const listRoute = () => ({ body: { success: true, repositories: REPOSITORIES } });

describe("read tools", () => {
  test("list_repositories filters by status and name and caps the count", async () => {
    const { call, calls } = toolSession({ "GET /api/github/repositories": listRoute });

    const failed = await call("list_repositories", { status: "failed" });
    expect(failed.data.total).toBe(2);
    expect(failed.data.repositories.map((r: { id: string }) => r.id)).toEqual(["r2", "r4"]);
    expect(failed.data.repositories[0].errorMessage).toBe("clone failed: authentication required");
    expect(failed.data.repositories[1].errorMessage.length).toBe(501);

    const acme = await call("list_repositories", { search: "ACME/", limit: 1 });
    expect(acme.data.total).toBe(2);
    expect(acme.data.repositories).toEqual([
      { id: "r3", fullName: "acme/tools", status: "imported", lastMirrored: null, mirroredLocation: null },
    ]);

    expect(calls.every((call) => call.headers.get("x-api-key") === API_KEY)).toBe(true);
  });

  test("get_repository by id shows the record and its five newest events", async () => {
    const activities = [
      ...Array.from({ length: 7 }, (_, i) => ({
        repositoryId: "r2",
        status: "failed",
        message: `attempt ${i}`,
        timestamp: `2026-10-2${i}T00:00:00.000Z`,
      })),
      { repositoryId: "r1", status: "mirrored", message: "other repo", timestamp: "2026-10-01T00:00:00.000Z" },
    ];
    const { call, calls } = toolSession({
      "GET /api/repositories/r2": () => ({ body: { success: true, repository: REPOSITORIES[1] } }),
      "GET /api/activities": () => ({ body: { success: true, activities } }),
    });

    const result = await call("get_repository", { repository: "r2" });
    expect(result.data.repository).toMatchObject({
      id: "r2",
      fullName: "octocat/broken",
      status: "failed",
      errorMessage: "clone failed: authentication required",
    });
    expect(result.data.recentActivity.map((a: { message: string }) => a.message)).toEqual([
      "attempt 0",
      "attempt 1",
      "attempt 2",
      "attempt 3",
      "attempt 4",
    ]);
    expect(calls.map((call) => call.path)).toEqual(["/api/repositories/r2", "/api/activities"]);
  });

  test("get_repository takes owner/name in any case", async () => {
    const { call } = toolSession({
      "GET /api/github/repositories": listRoute,
      "GET /api/activities": () => ({ body: { activities: [] } }),
    });
    const result = await call("get_repository", { repository: "OctoCat/Hello-World" });
    expect(result.data.repository.id).toBe("r1");
    expect(result.data.repository.mirroredLocation).toBe("mirrors/hello-world");
  });

  test("get_repository asks for an id when two sources track the same name", async () => {
    const { call } = toolSession({
      "GET /api/github/repositories": () => ({
        body: { repositories: [repo("a", "acme/tools", "mirrored"), repo("b", "acme/tools", "imported")] },
      }),
    });
    const result = await call("get_repository", { repository: "acme/tools" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("more than one source");
    expect(result.text).toContain("a, b");
  });

  test("get_repository explains unknown names and ids", async () => {
    const { call } = toolSession({
      "GET /api/github/repositories": listRoute,
      "GET /api/repositories/nope": () => ({ status: 404, body: { error: "Repository not found" } }),
    });
    const byName = await call("get_repository", { repository: "someone/else" });
    expect(byName.isError).toBe(true);
    expect(byName.text).toContain("add_repository");
    const byId = await call("get_repository", { repository: "nope" });
    expect(byId.isError).toBe(true);
    expect(byId.text).toContain("No tracked repository has the id nope");
  });

  test("list_failures returns only failed repositories with their errors", async () => {
    const { call } = toolSession({ "GET /api/github/repositories": listRoute });
    const result = await call("list_failures");
    expect(result.data.count).toBe(2);
    expect(result.data.repositories[0]).toEqual({
      id: "r2",
      fullName: "octocat/broken",
      lastMirrored: null,
      errorMessage: "clone failed: authentication required",
    });
  });

  test("list_organizations summarizes each organization", async () => {
    const { call } = toolSession({
      "GET /api/github/organizations": () => ({
        body: {
          organizations: [
            { id: "o1", name: "acme", status: "mirrored", repositoryCount: 12, avatarUrl: "x", membershipRole: "member" },
          ],
        },
      }),
    });
    const result = await call("list_organizations");
    expect(result.data).toEqual({
      total: 1,
      organizations: [{ id: "o1", name: "acme", status: "mirrored", repositoryCount: 12, lastMirrored: null }],
    });
  });
});

describe("add_repository", () => {
  test("adds from a URL with its host and path, then starts the mirror", async () => {
    const { call, calls } = toolSession({
      "POST /api/sync/repository": () => ({ body: { success: true, repository: repo("new", "group/sub/project", "imported") } }),
      "POST /api/job/mirror-repo": () => ({ body: { success: true, message: "Mirror job started." } }),
    });

    const result = await call("add_repository", {
      url: "https://GitLab.com/group/sub/project/-/tree/main",
      destinationOrg: "archive",
    });

    expect(result.data).toMatchObject({ added: true, mirrorStarted: true, repository: { id: "new", status: "imported" } });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/sync/repository",
      body: {
        owner: "group/sub",
        repo: "project",
        host: "gitlab.com",
        path: ["group", "sub", "project", "-", "tree", "main"],
        destinationOrg: "archive",
      },
    });
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(calls[1]).toMatchObject({ path: "/api/job/mirror-repo", body: { repositoryIds: ["new"] } });
  });

  test("owner/name goes to the default source without a host", async () => {
    const { call, calls } = toolSession({
      "POST /api/sync/repository": () => ({ body: { repository: repo("new", "octocat/hello-world", "imported") } }),
    });
    await call("add_repository", { url: "octocat/hello-world", mirror: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ owner: "octocat", repo: "hello-world", path: ["octocat", "hello-world"] });
  });

  test("an already mirrored repository is returned without starting a job", async () => {
    const { call, calls } = toolSession({
      "POST /api/sync/repository": () => ({ status: 409, body: { success: false, repository: REPOSITORIES[0] } }),
    });
    const result = await call("add_repository", { url: "git@github.com:octocat/hello-world.git" });
    expect(result.data).toMatchObject({ added: false, mirrorStarted: false, repository: { id: "r1" } });
    expect(result.data.note).toContain("sync_repositories");
    expect(calls.map((call) => call.path)).toEqual(["/api/sync/repository"]);
  });

  test("an already tracked repository that failed is retried", async () => {
    const { call, calls } = toolSession({
      "POST /api/sync/repository": () => ({ status: 409, body: { repository: REPOSITORIES[1] } }),
      "POST /api/job/retry-repo": () => ({ body: { success: true } }),
    });
    const result = await call("add_repository", { url: "https://github.com/octocat/broken" });
    expect(result.data).toMatchObject({ added: false, mirrorStarted: true });
    expect(calls[1]).toMatchObject({ path: "/api/job/retry-repo", body: { repositoryIds: ["r2"] } });
  });

  test("input that names no repository is refused before any call", async () => {
    const { call, calls } = toolSession({});
    const result = await call("add_repository", { url: "https://github.com/settings/tokens" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Could not read a repository");
    expect(calls).toHaveLength(0);
  });

  test("the app's own errors reach the model", async () => {
    const { call } = toolSession({
      "POST /api/sync/repository": () => ({
        status: 400,
        body: { success: false, error: "No connected source matches host gitlab.example.com" },
      }),
    });
    const result = await call("add_repository", { url: "https://gitlab.example.com/a/b" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No connected source matches host gitlab.example.com");
  });
});

describe("add_organization", () => {
  test("takes the name from a URL and mirrors the organization", async () => {
    const { call, calls } = toolSession({
      "POST /api/sync/organization": () => ({
        body: { organization: { id: "o1", name: "acme", status: "imported", repositoryCount: 3 } },
      }),
      "POST /api/job/mirror-org": () => ({ body: { success: true } }),
    });
    const result = await call("add_organization", { organization: "https://github.com/orgs/acme/repositories" });
    expect(result.data).toMatchObject({ added: true, mirrorStarted: true, organization: { id: "o1", repositoryCount: 3 } });
    expect(calls[0].body).toEqual({ org: "acme" });
    expect(calls[1]).toMatchObject({ path: "/api/job/mirror-org", body: { organizationIds: ["o1"] } });
  });

  test("a tracked organization that is mirroring now is left alone", async () => {
    const { call, calls } = toolSession({
      "POST /api/sync/organization": () => ({
        status: 409,
        body: { organization: { id: "o1", name: "acme", status: "mirroring" } },
      }),
    });
    const result = await call("add_organization", { organization: "acme" });
    expect(result.data).toMatchObject({ added: false, mirrorStarted: false });
    expect(calls).toHaveLength(1);
  });
});

describe("sync and retry", () => {
  test("pass the ids to the job endpoints and summarize what was queued", async () => {
    const { call, calls } = toolSession({
      "POST /api/job/sync-repo": () => ({ body: { message: "Sync job started.", repositories: [REPOSITORIES[0]] } }),
      "POST /api/job/retry-repo": () => ({ body: { message: "Retry job (sync/mirror) started.", repositories: [REPOSITORIES[1]] } }),
    });

    const synced = await call("sync_repositories", { repositoryIds: ["r1"] });
    expect(synced.data).toEqual({
      message: "Sync job started.",
      repositories: [{ id: "r1", fullName: "octocat/hello-world", status: "mirrored" }],
    });
    const retried = await call("retry_repositories", { repositoryIds: ["r2"] });
    expect(retried.data.repositories[0].id).toBe("r2");
    expect(calls.map((call) => [call.path, call.body])).toEqual([
      ["/api/job/sync-repo", { repositoryIds: ["r1"] }],
      ["/api/job/retry-repo", { repositoryIds: ["r2"] }],
    ]);
  });

  test("a read only key gets the app's refusal back", async () => {
    const { call } = toolSession({
      "POST /api/job/sync-repo": () => ({
        status: 403,
        body: { success: false, error: "This API key is read only.", code: "API_KEY_READ_ONLY" },
      }),
    });
    const result = await call("sync_repositories", { repositoryIds: ["r1"] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("read only");
  });

  test("an empty id list is rejected by the schema", async () => {
    const { call, calls } = toolSession({});
    const result = await call("retry_repositories", { repositoryIds: [] });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
