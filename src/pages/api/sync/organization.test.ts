/**
 * Route tests for POST /api/sync/organization: the public add-org branch that
 * find-or-creates a tokenless source row when the request carries a provider
 * (and an optional sourceUrl) instead of a sourceId, plus the metadata
 * fallback for anonymous (rate-limited) org lookups.
 *
 * NOTE: these tests replace @/lib/db, @/lib/sources and
 * @/lib/source-providers with mocks. bun's mock.module is process-wide and
 * leaks into other test files, so in the shared test process this file
 * registers NOTHING: it re-runs itself in an isolated child process (the
 * same harness as organizations/[id].test.ts).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { APIContext, APIRoute } from "astro";
import type { GitOrg } from "@/types/organizations";
import type { GitRepo } from "@/types/Repository";
import {
  SOURCE_PROVIDER_LABELS,
  normalizeSourceUrl,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";

const CHILD_FLAG = "GM_SYNC_ORG_ROUTE_ISOLATED";
const isChild = !!process.env[CHILD_FLAG];

if (!isChild) {
  test("sync organization route (public add-org) — isolated child suite", () => {
    const res = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      env: { ...process.env, [CHILD_FLAG]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) {
      console.error(res.stdout.toString());
      console.error(res.stderr.toString());
    }
    expect(res.exitCode).toBe(0);
  }, 60_000);
}

/** Shape of a sources table row, as listSources/createSource return it. */
interface SourceRow {
  id: string;
  userId: string;
  name: string;
  provider: SourceProviderKind;
  url: string;
  username: string;
  token: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

let sourceIdCounter = 0;

function makeSourceRow(
  overrides: Partial<SourceRow> & { userId?: string }
): SourceRow {
  sourceIdCounter += 1;
  const provider = overrides.provider ?? "github";
  const username = overrides.username ?? "";
  return {
    id: `source-${sourceIdCounter}`,
    userId: overrides.userId ?? "user-1",
    name: SOURCE_PROVIDER_LABELS[provider],
    provider,
    url: overrides.url ?? "https://github.com",
    username,
    token: overrides.token ?? null,
    enabled: true,
    createdAt: new Date(Date.now() + sourceIdCounter),
    updatedAt: new Date(Date.now() + sourceIdCounter),
    ...overrides,
  };
}

type OrgRow = Record<string, unknown>;
type ConfigRow = Record<string, unknown>;

let sourceRows: SourceRow[] = [];
let orgRows: OrgRow[] = [];
let configRows: ConfigRow[] = [];
let insertedRepoRows: OrgRow[] = [];
let insertedOrgRecords: OrgRow[] = [];
let lastProviderSource: SourceRow | undefined;

// Behavior knobs for the source provider double.
let orgMetadataResult: GitOrg | null;
/** When set, getOrganization throws it (e.g. an anonymous rate limit). */
let orgMetadataError: { status?: number } & Error;
let orgReposResult: GitRepo[];

const organizationsTable = { tableName: "organizations" };
const repositoriesTable = { tableName: "repositories" };
const configsTable = { tableName: "configs" };

/** Leaf values of a drizzle where() condition (conditions are cyclic). */
function conditionLeafValues(node: unknown, depth = 0): unknown[] {
  if (node == null || depth > 8) return [];
  if (typeof node !== "object") return [node];
  const leaves: unknown[] = [];
  const record = node as { value?: unknown; queryChunks?: unknown[] };
  if (Array.isArray(record.value)) leaves.push(...record.value);
  for (const chunk of record.queryChunks ?? []) {
    leaves.push(...conditionLeafValues(chunk, depth + 1));
  }
  return leaves;
}

/** An insert that is awaited directly (organizations) or chained with
 * onConflictDoNothing (repositories) — a thenable carrying the chain. */
type PendingInsert = PromiseLike<void> & {
  onConflictDoNothing: (config?: unknown) => Promise<void>;
};

function repoFixture(name: string): GitRepo {
  return {
    name,
    fullName: `acme/${name}`,
    url: `https://gitlab.com/acme/${name}`,
    cloneUrl: `https://gitlab.com/acme/${name}.git`,
    owner: "acme",
    organization: "acme",
    isPrivate: false,
    isForked: false,
    hasIssues: true,
    isStarred: false,
    isArchived: false,
    size: 123,
    hasLFS: false,
    hasSubmodules: false,
    language: "TypeScript",
    description: `${name} fixture`,
    defaultBranch: "main",
    visibility: "public",
    status: "imported",
    importedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

if (isChild) {
  mock.module("@/lib/db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => ({
            limit: async (): Promise<OrgRow[]> => {
              const leaves = conditionLeafValues(cond);
              if (table === organizationsTable) {
                return orgRows
                  .filter(
                    (row) =>
                      leaves.includes(row.normalizedName) &&
                      leaves.includes(row.userId)
                  )
                  .slice(0, 1);
              }
              if (table === configsTable) {
                return configRows
                  .filter((row) => leaves.includes(row.userId))
                  .slice(0, 1);
              }
              return [];
            },
          }),
        }),
      }),
      update: () => ({
        set: (data: OrgRow) => ({
          where: () => ({
            returning: async (): Promise<OrgRow[]> => {
              if (!orgRows[0]) return [];
              Object.assign(orgRows[0], data);
              return [orgRows[0]];
            },
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (record: OrgRow | OrgRow[]): PendingInsert => {
          const rows = Array.isArray(record) ? record : [record];
          const apply = async (): Promise<void> => {
            if (table === organizationsTable) {
              insertedOrgRecords.push(...rows);
              // Inserted orgs must be selectable again, like in a real
              // database, or the duplicate-org check cannot find them.
              orgRows.push(...rows);
            } else if (table === repositoriesTable) {
              insertedRepoRows.push(...rows);
            }
          };
          return {
            onConflictDoNothing: async () => {
              await apply();
            },
            then: (onfulfilled, onrejected) =>
              apply().then(onfulfilled, onrejected),
          };
        },
      }),
    },
    organizations: organizationsTable,
    repositories: repositoriesTable,
    configs: configsTable,
    users: {},
    events: {},
    mirrorJobs: {},
    sessions: {},
    accounts: {},
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
    sources: {},
  }));

  mock.module("@/lib/sources", () => {
    class DuplicateSourceError extends Error {
      readonly code = "duplicate_source";

      constructor(label: string) {
        super(`${label} is already connected. Remove it first to re-add or change it.`);
        this.name = "DuplicateSourceError";
      }
    }

    return {
      DuplicateSourceError,
      listSources: async (userId: string): Promise<SourceRow[]> =>
        sourceRows
          .filter((source) => source.userId === userId)
          .sort((a, b) => +a.createdAt - +b.createdAt),
      createSource: async (
        userId: string,
        input: {
          provider: SourceProviderKind;
          url?: string | null;
          username?: string | null;
          token?: string | null;
        }
      ): Promise<SourceRow> => {
        const url = normalizeSourceUrl(input.url, input.provider);
        const username = (input.username ?? "").trim();
        const duplicate = sourceRows.some(
          (source) =>
            source.userId === userId &&
            source.provider === input.provider &&
            source.url === url &&
            source.username === username
        );
        if (duplicate) {
          throw new DuplicateSourceError(
            `${SOURCE_PROVIDER_LABELS[input.provider]} (${url})`
          );
        }
        const row = makeSourceRow({
          userId,
          provider: input.provider,
          url,
          username,
          token: input.token ? `enc:${input.token}` : null,
        });
        sourceRows.push(row);
        return row;
      },
    };
  });

  mock.module("@/lib/source-providers", () => ({
    createSourceProviderFromSource: (source: SourceRow) => {
      lastProviderSource = source;
      return {
        getOrganization: async (name: string): Promise<GitOrg | null> => {
          if (orgMetadataError !== undefined) throw orgMetadataError;
          if (orgMetadataResult === null) return null;
          return { ...orgMetadataResult, name };
        },
        listOrganizationRepositories: async (): Promise<GitRepo[]> =>
          orgReposResult.slice(),
      };
    },
  }));
}

const { POST } = isChild
  ? await import("./organization")
  : { POST: undefined as unknown as APIRoute };

function postOrg(body: Record<string, unknown>): Promise<Response> {
  const request = new Request("http://localhost/api/sync/organization", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST({
    request,
    locals: { session: { userId: "user-1" } },
  } as unknown as APIContext);
}

beforeEach(() => {
  sourceRows = [];
  orgRows = [];
  // No source token configured: the legacy 401 gate would have refused every
  // request below.
  configRows = [
    {
      id: "config-1",
      userId: "user-1",
      isActive: true,
      githubConfig: null,
      giteaConfig: {
        url: "https://gitea.example.com",
        token: "gitea-token",
        username: "giteaUser",
      },
    },
  ];
  insertedRepoRows = [];
  insertedOrgRecords = [];
  lastProviderSource = undefined;
  orgMetadataResult = {
    name: "acme",
    avatarUrl: "https://gitlab.com/uploads/-/system/group/avatar/1/logo.png",
    membershipRole: "member",
    isIncluded: false,
    status: "imported",
    repositoryCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  orgMetadataError = undefined;
  orgReposResult = [repoFixture("alpha"), repoFixture("beta")];
});

describe.skipIf(!isChild)("POST /api/sync/organization public add-org", () => {
  test("creates exactly one tokenless source row when none is configured", async () => {
    const response = await postOrg({
      org: "acme",
      role: "member",
      provider: "gitlab",
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0]).toMatchObject({
      provider: "gitlab",
      url: "https://gitlab.com",
      username: "",
      token: null,
    });
    expect(insertedOrgRecords).toHaveLength(1);
    expect(insertedOrgRecords[0].sourceId).toBe(sourceRows[0].id);
    expect(insertedRepoRows).toHaveLength(2);
    for (const row of insertedRepoRows) {
      expect(row.sourceId).toBe(sourceRows[0].id);
    }
    expect(insertedOrgRecords[0].repositoryCount).toBe(2);
    expect(lastProviderSource?.id).toBe(sourceRows[0].id);
  });

  test("409 on a duplicate org, and a different org reuses the tokenless row", async () => {
    const first = await postOrg({
      org: "acme",
      role: "member",
      provider: "gitlab",
    });
    expect(first.status).toBe(200);
    expect(sourceRows).toHaveLength(1);
    const tokenlessId = sourceRows[0].id;

    const duplicate = await postOrg({
      org: "acme",
      role: "member",
      provider: "gitlab",
    });
    expect(duplicate.status).toBe(409);
    const dupData = await duplicate.json();
    expect(dupData.error).toContain("already exists");
    expect(sourceRows).toHaveLength(1);

    const other = await postOrg({
      org: "other-group",
      role: "member",
      provider: "gitlab",
    });
    expect(other.status).toBe(200);
    // The tokenless row is reused, not duplicated.
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].id).toBe(tokenlessId);
    expect(insertedOrgRecords).toHaveLength(2);
    expect(insertedOrgRecords[1].sourceId).toBe(tokenlessId);
  });

  test("normalizes a custom sourceUrl onto the created source", async () => {
    const response = await postOrg({
      org: "acme",
      role: "member",
      provider: "github",
      sourceUrl: "github.example.com/",
    });

    expect(response.status).toBe(200);
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].provider).toBe("github");
    expect(sourceRows[0].url).toBe("https://github.example.com");
  });

  test("force:true re-pins an existing org to the tokenless source", async () => {
    const legacy = makeSourceRow({
      provider: "github",
      url: "https://github.com",
      username: "octocat",
      token: "enc:gh-token",
    });
    sourceRows = [legacy];
    orgRows = [
      {
        id: "org-1",
        userId: "user-1",
        name: "acme",
        normalizedName: "acme",
        membershipRole: "admin",
        sourceId: legacy.id,
      },
    ];

    const response = await postOrg({
      org: "acme",
      role: "member",
      provider: "gitlab",
      force: true,
    });

    expect(response.status).toBe(200);
    expect(sourceRows).toHaveLength(2);
    const tokenless = sourceRows.find((source) => !source.username);
    expect(tokenless).toMatchObject({ provider: "gitlab", url: "https://gitlab.com" });
    expect(orgRows[0].sourceId).toBe(tokenless?.id);
    // The force branch only re-pins; it does not re-import repositories.
    expect(insertedRepoRows).toHaveLength(0);
  });

  test("a rate-limited org metadata fetch (403) still imports with a fallback record", async () => {
    orgMetadataError = Object.assign(
      new Error("rate limit exceeded"),
      { status: 403 }
    );

    const response = await postOrg({
      org: "acme",
      role: "member",
      provider: "gitlab",
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(insertedOrgRecords).toHaveLength(1);
    expect(insertedOrgRecords[0]).toMatchObject({
      name: "acme",
      avatarUrl: "",
      status: "imported",
      repositoryCount: 2,
    });
    expect(insertedRepoRows).toHaveLength(2);
  });

  test("getOrganization returning null still 404s", async () => {
    orgMetadataResult = null;

    const response = await postOrg({
      org: "ghost",
      role: "member",
      provider: "gitlab",
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain("was not found");
    expect(insertedOrgRecords).toHaveLength(0);
    expect(insertedRepoRows).toHaveLength(0);
  });

  test("an unsupported provider is rejected with 400", async () => {
    const response = await postOrg({
      org: "acme",
      role: "member",
      provider: "bitbucket",
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Unsupported provider");
    expect(sourceRows).toHaveLength(0);
    expect(insertedOrgRecords).toHaveLength(0);
  });

  test("legacy requests without provider or sources keep the 400 branch", async () => {
    const response = await postOrg({ org: "acme", role: "member" });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("No source is configured");
    expect(sourceRows).toHaveLength(0);
  });
});
