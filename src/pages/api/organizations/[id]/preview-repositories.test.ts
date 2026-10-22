/**
 * Route tests for GET /api/organizations/:id/preview-repositories.
 *
 * The organization tag-rule preview offers these repositories in a picker, so
 * what matters is that the list is scoped to the caller, limited to the rows
 * that belong to the organization, and shaped with a display label.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

let orgRows: any[] = [];
let repoRows: any[] = [];
const mockOrganizations = {};
const mockRepositories = {};

// A select chain that answers both query shapes the route runs: the organization
// lookup ends at limit(), the repository listing passes through orderBy() first.
const mockDb = {
  select: mock(() => ({
    from: mock((table: any) => ({
      where: mock(() => ({
        limit: mock(() =>
          Promise.resolve(table === mockOrganizations ? orgRows : repoRows)
        ),
        orderBy: mock(() => ({
          limit: mock(() =>
            Promise.resolve(table === mockRepositories ? repoRows : orgRows)
          ),
        })),
      })),
    })),
  })),
};

// The route pulls in the auth module, which imports every table, so the mock has
// to name them all.
mock.module("@/lib/db", () => ({
  db: mockDb,
  repositories: mockRepositories,
  configs: {},
  organizations: mockOrganizations,
  users: {},
  mirrorJobs: {},
  events: {},
  accounts: {},
  sessions: {},
  verificationTokens: {},
  verifications: {},
  oauthClients: {},
  oauthAccessTokens: {},
  oauthRefreshTokens: {},
  oauthConsents: {},
  jwkss: {},
  ssoProviders: {},
  apikeys: {},
  rateLimits: {},
}));

const { GET } = await import("./preview-repositories");

function call(id?: string) {
  return GET({
    params: id ? { id } : {},
    request: new Request("http://localhost/api/organizations/preview-repositories"),
    locals: { session: { userId: "user-1" } },
  } as any);
}

beforeEach(() => {
  orgRows = [{ name: "octo-org" }];
  repoRows = [
    { id: "r1", name: "hello", owner: "octo-org" },
    { id: "r2", name: "world", owner: "octo-org" },
  ];
});

describe("GET /api/organizations/:id/preview-repositories", () => {
  test("lists the organization's repositories with a display label", async () => {
    const response = await call("org-1");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.organization).toBe("octo-org");
    expect(data.repositories).toEqual([
      { id: "r1", label: "octo-org/hello" },
      { id: "r2", label: "octo-org/world" },
    ]);
  });

  test("answers 404 for an organization the account does not own", async () => {
    orgRows = [];
    const response = await call("org-1");
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.success).toBe(false);
  });

  test("requires an organization id", async () => {
    const response = await call();
    expect(response.status).toBe(400);
  });

  test("returns an empty list when the organization mirrors nothing yet", async () => {
    repoRows = [];
    const response = await call("org-1");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.repositories).toEqual([]);
  });
});
