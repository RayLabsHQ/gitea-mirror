/**
 * Unit tests for archiveGiteaRepo's return value and sanitizeRepoNameAlphaDashDot —
 * regression coverage for #331's follow-up (repos falsely flagged as orphaned
 * and archived, then unreachable by "Manual Sync" because the DB's
 * mirroredLocation/name were never updated to the post-rename name).
 *
 * archiveGiteaRepo now reports the Gitea-side name it ended up with after a
 * rename (mirror path) so callers (repository-cleanup-service.ts) can persist
 * it, instead of leaving the DB pointing at a name that no longer exists.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const mockHttpGet = mock(async (_url: string, _headers?: any) => ({
  data: {},
  status: 200,
  statusText: "OK",
  headers: new Headers(),
}));

const mockHttpPatch = mock(async (_url: string, _body?: any, _headers?: any) => ({
  data: {},
  status: 200,
  statusText: "OK",
  headers: new Headers(),
}));

const mockHttpPost = mock(async () => ({
  data: {},
  status: 200,
  statusText: "OK",
  headers: new Headers(),
}));

const mockHttpDelete = mock(async () => ({
  data: {},
  status: 200,
  statusText: "OK",
  headers: new Headers(),
}));

const mockHttpPut = mock(async () => ({
  data: {},
  status: 200,
  statusText: "OK",
  headers: new Headers(),
}));

class MockHttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public response?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

mock.module("@/lib/http-client", () => ({
  httpGet: mockHttpGet,
  httpPatch: mockHttpPatch,
  httpPost: mockHttpPost,
  httpDelete: mockHttpDelete,
  httpPut: mockHttpPut,
  HttpError: MockHttpError,
}));

import { archiveGiteaRepo, sanitizeRepoNameAlphaDashDot } from "./gitea";

describe("sanitizeRepoNameAlphaDashDot", () => {
  test("replaces disallowed characters with a dash", () => {
    expect(sanitizeRepoNameAlphaDashDot("my repo!")).toBe("my-repo");
  });

  test("collapses consecutive disallowed characters into a single dash", () => {
    expect(sanitizeRepoNameAlphaDashDot("a___b")).toBe("a-b");
  });

  test("trims leading and trailing separators/dots", () => {
    expect(sanitizeRepoNameAlphaDashDot("--.foo.--")).toBe("foo");
  });

  test("leaves an already-valid AlphaDashDot name unchanged", () => {
    expect(sanitizeRepoNameAlphaDashDot("valid-repo.name")).toBe("valid-repo.name");
  });
});

describe("archiveGiteaRepo", () => {
  const client = { url: "https://gitea.example.com", token: "test-token" };

  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let originalConsoleError: typeof console.error;
  let originalConsoleDebug: typeof console.debug;

  beforeEach(() => {
    mockHttpGet.mockClear();
    mockHttpPatch.mockClear();
    mockHttpPost.mockClear();
    mockHttpDelete.mockClear();

    // Reset to benign defaults; individual tests override with mockImplementationOnce/mockImplementation.
    mockHttpGet.mockImplementation(async () => ({
      data: {},
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));
    mockHttpPatch.mockImplementation(async () => ({
      data: {},
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));

    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    originalConsoleError = console.error;
    originalConsoleDebug = console.debug;
    console.log = mock(() => {});
    console.warn = mock(() => {});
    console.error = mock(() => {});
    console.debug = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    console.debug = originalConsoleDebug;
  });

  test("mirror repo rename returns the new archived name", async () => {
    mockHttpGet.mockImplementationOnce(async () => ({
      data: { name: "my-repo", mirror: true, description: "" },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));

    const result = await archiveGiteaRepo(client, "owner", "my-repo");

    expect(result).toEqual({ archivedName: "archived-my-repo" });

    // Rename PATCH + mirror-interval-disable PATCH
    expect(mockHttpPatch).toHaveBeenCalledTimes(2);
    const renameCall = mockHttpPatch.mock.calls[0];
    expect(String(renameCall[0])).toContain("/api/v1/repos/owner/my-repo");
    expect(renameCall[1]).toMatchObject({ name: "archived-my-repo" });
  });

  test("already-archived mirror repo returns the existing name without re-renaming", async () => {
    mockHttpGet.mockImplementationOnce(async () => ({
      data: { name: "archived-my-repo", mirror: true, description: "" },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));

    const result = await archiveGiteaRepo(client, "owner", "archived-my-repo");

    expect(result).toEqual({ archivedName: "archived-my-repo" });
    expect(mockHttpPatch).not.toHaveBeenCalled();
  });

  test("non-mirror repo archives natively and returns archivedName: null", async () => {
    mockHttpGet.mockImplementationOnce(async () => ({
      data: { name: "regular-repo", mirror: false, description: "" },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));
    mockHttpPatch.mockImplementationOnce(async () => ({
      data: { archived: true },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));

    const result = await archiveGiteaRepo(client, "owner", "regular-repo");

    expect(result).toEqual({ archivedName: null });
    expect(mockHttpPatch).toHaveBeenCalledTimes(1);
    expect(mockHttpPatch.mock.calls[0][1]).toMatchObject({ archived: true });
  });

  test("rename PATCH failure (primary and timestamped fallback both fail) returns archivedName: null", async () => {
    mockHttpGet.mockImplementationOnce(async () => ({
      data: { name: "my-repo", mirror: true, description: "" },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));
    mockHttpPatch.mockImplementation(async () => {
      throw new MockHttpError("Unprocessable Entity", 422, "Unprocessable Entity");
    });

    const result = await archiveGiteaRepo(client, "owner", "my-repo");

    expect(result).toEqual({ archivedName: null });
    // Primary rename attempt + timestamped fallback attempt, no interval-disable call
    expect(mockHttpPatch).toHaveBeenCalledTimes(2);
  });

  test("mirror repo rename recovers via timestamped fallback after a primary conflict", async () => {
    mockHttpGet.mockImplementationOnce(async () => ({
      data: { name: "my-repo", mirror: true, description: "" },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));

    let callCount = 0;
    mockHttpPatch.mockImplementation(async (url: string, body?: any) => {
      callCount++;
      if (callCount === 1) {
        // Primary rename attempt fails (e.g. AlphaDashDot conflict)
        throw new MockHttpError("conflict", 422, "Unprocessable Entity");
      }
      // Fallback rename attempt and the interval-disable PATCH both succeed
      return { data: {}, status: 200, statusText: "OK", headers: new Headers() };
    });

    const result = await archiveGiteaRepo(client, "owner", "my-repo");

    expect(result.archivedName).toMatch(/^archived-\d{14}-my-repo$/);
    expect(mockHttpPatch).toHaveBeenCalledTimes(3);
  });

  test("repository not found in Gitea returns archivedName: null", async () => {
    mockHttpGet.mockImplementationOnce(async () => ({
      data: null,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    }));

    const result = await archiveGiteaRepo(client, "owner", "missing-repo");

    expect(result).toEqual({ archivedName: null });
    expect(mockHttpPatch).not.toHaveBeenCalled();
  });
});
