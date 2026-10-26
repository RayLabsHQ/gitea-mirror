import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, type GiteaMirrorClient } from "./client";
import {
  parseGitHubOwnerReference,
  parseGitHubRepoReference,
  parseRepoReferenceParts,
} from "../../src/lib/utils/github-url";

/** The fields of a tracked repository these tools read (GET /api/github/repositories). */
export interface ApiRepository {
  id: string;
  name: string;
  fullName: string;
  owner?: string;
  organization?: string | null;
  status: string;
  lastMirrored?: string | null;
  errorMessage?: string | null;
  mirroredLocation?: string | null;
  destinationOrg?: string | null;
  sourceProvider?: string | null;
  isPrivate?: boolean;
  url?: string;
}

export interface ApiOrganization {
  id: string;
  name: string;
  status: string;
  repositoryCount?: number;
  lastMirrored?: string | null;
  errorMessage?: string | null;
}

interface ApiActivity {
  repositoryId?: string;
  status: string;
  message: string;
  timestamp: string;
}

interface JobResponse {
  message?: string;
  repositories?: ApiRepository[];
}

export const REPOSITORY_STATUSES = [
  "imported",
  "mirroring",
  "mirrored",
  "failed",
  "skipped",
  "ignored",
  "deleting",
  "deleted",
  "syncing",
  "synced",
  "archived",
  "pending-approval",
] as const;

const DONE_STATUSES = new Set(["mirrored", "synced"]);
const RUNNING_STATUSES = new Set(["mirroring", "syncing", "deleting"]);

/** Long error messages are mostly stack noise; the start says what broke. */
const ERROR_TEXT_LIMIT = 500;
const RECENT_ACTIVITY_LIMIT = 5;
const MAX_IDS_PER_CALL = 50;

/** A mistake in the tool input, reported back to the model as is. */
class ToolInputError extends Error {}

function clip(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT)}…` : text;
}

function summarizeRepository(repo: ApiRepository) {
  return {
    id: repo.id,
    fullName: repo.fullName,
    status: repo.status,
    lastMirrored: repo.lastMirrored ?? null,
    mirroredLocation: repo.mirroredLocation || null,
    ...(repo.status === "failed" && repo.errorMessage ? { errorMessage: clip(repo.errorMessage) } : {}),
  };
}

function describeRepository(repo: ApiRepository) {
  return {
    id: repo.id,
    fullName: repo.fullName,
    status: repo.status,
    sourceProvider: repo.sourceProvider ?? null,
    sourceUrl: repo.url ?? null,
    isPrivate: repo.isPrivate ?? null,
    organization: repo.organization ?? null,
    destinationOrg: repo.destinationOrg ?? null,
    mirroredLocation: repo.mirroredLocation || null,
    lastMirrored: repo.lastMirrored ?? null,
    errorMessage: clip(repo.errorMessage) ?? null,
  };
}

function summarizeOrganization(org: ApiOrganization) {
  return {
    id: org.id,
    name: org.name,
    status: org.status,
    repositoryCount: org.repositoryCount ?? null,
    lastMirrored: org.lastMirrored ?? null,
    ...(org.status === "failed" && org.errorMessage ? { errorMessage: clip(org.errorMessage) } : {}),
  };
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await action());
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof ApiError) return fail(error.message);
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function listRepositories(client: GiteaMirrorClient): Promise<ApiRepository[]> {
  const body = await client.get<{ repositories?: ApiRepository[] }>("/api/github/repositories");
  return Array.isArray(body.repositories) ? body.repositories : [];
}

/** Find a tracked repository by id, or by owner/name when the value has a slash. */
async function findRepository(client: GiteaMirrorClient, value: string): Promise<ApiRepository> {
  if (value.includes("/")) {
    const wanted = value.toLowerCase();
    const matches = (await listRepositories(client)).filter(
      (repo) => repo.fullName.toLowerCase() === wanted
    );
    if (matches.length === 0) {
      throw new ToolInputError(`No tracked repository is named ${value}. Add it with add_repository first.`);
    }
    if (matches.length > 1) {
      throw new ToolInputError(
        `${value} is tracked from more than one source. Pass one of these ids instead: ${matches.map((repo) => repo.id).join(", ")}`
      );
    }
    return matches[0];
  }

  try {
    const body = await client.get<{ repository: ApiRepository }>(
      `/api/repositories/${encodeURIComponent(value)}`
    );
    return body.repository;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ToolInputError(`No tracked repository has the id ${value}. list_repositories shows the ids.`);
    }
    throw error;
  }
}

const repositoryIdsSchema = z
  .array(z.string().trim().min(1).max(100))
  .min(1)
  .max(MAX_IDS_PER_CALL)
  .describe("Repository ids from list_repositories, list_failures or add_repository");

function summarizeJob(body: JobResponse) {
  return {
    message: body.message ?? null,
    repositories: (body.repositories ?? []).map((repo) => ({
      id: repo.id,
      fullName: repo.fullName,
      status: repo.status,
    })),
  };
}

export function registerTools(server: McpServer, client: GiteaMirrorClient): void {
  server.registerTool(
    "list_repositories",
    {
      title: "List repositories",
      description:
        "List the repositories Gitea Mirror tracks with their mirror status, most recently added first. Filter by status or by part of the owner/name.",
      inputSchema: {
        status: z.enum(REPOSITORY_STATUSES).optional().describe("Only repositories with this status"),
        search: z.string().trim().min(1).max(200).optional().describe("Case-insensitive match on owner/name"),
        limit: z.number().int().min(1).max(200).default(50).describe("How many repositories to return"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ status, search, limit }) =>
      run(async () => {
        const needle = search?.toLowerCase();
        const matching = (await listRepositories(client)).filter(
          (repo) =>
            (!status || repo.status === status) &&
            (!needle || repo.fullName.toLowerCase().includes(needle))
        );
        return {
          total: matching.length,
          repositories: matching.slice(0, limit).map(summarizeRepository),
        };
      })
  );

  server.registerTool(
    "get_repository",
    {
      title: "Get a repository",
      description:
        "Show one tracked repository: its status, where it is mirrored to, the last error and its recent activity.",
      inputSchema: {
        repository: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .describe("The repository id, or its owner/name as list_repositories shows it"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repository }) =>
      run(async () => {
        const repo = await findRepository(client, repository);
        const { activities = [] } = await client.get<{ activities?: ApiActivity[] }>("/api/activities");
        return {
          repository: describeRepository(repo),
          recentActivity: activities
            .filter((activity) => activity.repositoryId === repo.id)
            .slice(0, RECENT_ACTIVITY_LIMIT)
            .map((activity) => ({
              timestamp: activity.timestamp,
              status: activity.status,
              message: clip(activity.message) ?? "",
            })),
        };
      })
  );

  server.registerTool(
    "list_failures",
    {
      title: "List failed repositories",
      description:
        "List the repositories whose last mirror or sync failed, with the error message. Retry them with retry_repositories.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const failed = (await listRepositories(client)).filter((repo) => repo.status === "failed");
        return {
          count: failed.length,
          repositories: failed.map((repo) => ({
            id: repo.id,
            fullName: repo.fullName,
            lastMirrored: repo.lastMirrored ?? null,
            errorMessage: clip(repo.errorMessage) ?? null,
          })),
        };
      })
  );

  server.registerTool(
    "list_organizations",
    {
      title: "List organizations",
      description:
        "List the organizations Gitea Mirror tracks with their status and repository count. Each repository in them keeps its own status.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const body = await client.get<{ organizations?: ApiOrganization[] }>("/api/github/organizations");
        const organizations = Array.isArray(body.organizations) ? body.organizations : [];
        return { total: organizations.length, organizations: organizations.map(summarizeOrganization) };
      })
  );

  server.registerTool(
    "add_repository",
    {
      title: "Add a repository",
      description:
        "Start tracking a repository and, unless mirror is false, start mirroring it. Takes a browser, clone or SSH URL from any connected source, or owner/name for the default source. Adding a repository that is already tracked returns it instead of a copy.",
      inputSchema: {
        url: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe("For example https://github.com/octocat/hello-world, git@gitlab.com:group/project.git or octocat/hello-world"),
        destinationOrg: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Mirror into this Gitea organization instead of the configured default"),
        mirror: z.boolean().default(true).describe("Start mirroring right away"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ url, destinationOrg, mirror }) =>
      run(async () => {
        const reference = parseGitHubRepoReference(url);
        const parts = parseRepoReferenceParts(url);
        if (!reference || !parts) {
          throw new ToolInputError(`Could not read a repository from "${url}". Pass its URL or owner/name.`);
        }

        const added = await client.post<{ repository?: ApiRepository }>(
          "/api/sync/repository",
          {
            owner: reference.owner,
            repo: reference.repo,
            ...(parts.host ? { host: parts.host } : {}),
            path: parts.segments,
            ...(destinationOrg ? { destinationOrg } : {}),
          },
          [409]
        );
        const repository = added.body.repository;
        if (!repository?.id) throw new Error("Gitea Mirror did not return the repository it added.");
        const alreadyTracked = added.status === 409;

        let mirrorStarted = false;
        let note: string;
        if (!mirror) {
          note = "Not mirrored yet. Start it with retry_repositories, or let the scheduler pick it up.";
        } else if (alreadyTracked && DONE_STATUSES.has(repository.status)) {
          note = "Already tracked and mirrored. Use sync_repositories to pull the latest changes.";
        } else if (alreadyTracked && RUNNING_STATUSES.has(repository.status)) {
          note = "Already tracked, and a mirror or sync is running now.";
        } else if (repository.status === "ignored") {
          note = "This repository is set to ignored in Gitea Mirror. Change that in the app to mirror it.";
        } else if (repository.status === "pending-approval") {
          note = "This repository waits for a force-push approval in the app before it syncs again.";
        } else {
          // A new row goes through the documented mirror call; a tracked one
          // that failed or never ran goes through retry, which also syncs a
          // mirror that already exists on the destination.
          await client.post(alreadyTracked ? "/api/job/retry-repo" : "/api/job/mirror-repo", {
            repositoryIds: [repository.id],
          });
          mirrorStarted = true;
          note = "Mirroring runs in the background. Check progress with get_repository.";
        }

        return {
          added: !alreadyTracked,
          mirrorStarted,
          repository: summarizeRepository(repository),
          note,
        };
      })
  );

  server.registerTool(
    "add_organization",
    {
      title: "Add an organization",
      description:
        "Start tracking an organization from the first connected source, with every repository in it, and unless mirror is false start mirroring them. A user account is not an organization: add its repositories one at a time.",
      inputSchema: {
        organization: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .describe("The organization name, or its URL on the source"),
        mirror: z.boolean().default(true).describe("Start mirroring its repositories right away"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ organization, mirror }) =>
      run(async () => {
        const name = parseGitHubOwnerReference(organization) ?? organization.trim();
        const added = await client.post<{ organization?: ApiOrganization }>(
          "/api/sync/organization",
          { org: name },
          [409]
        );
        const org = added.body.organization;
        if (!org?.id) throw new Error("Gitea Mirror did not return the organization it added.");
        const alreadyTracked = added.status === 409;

        let mirrorStarted = false;
        let note: string;
        if (!mirror) {
          note = "Its repositories are tracked but not mirrored yet.";
        } else if (alreadyTracked && org.status === "mirroring") {
          note = "Already tracked, and a mirror is running now.";
        } else if (org.status === "ignored") {
          note = "This organization is set to ignored in Gitea Mirror. Change that in the app to mirror it.";
        } else {
          await client.post("/api/job/mirror-org", { organizationIds: [org.id] });
          mirrorStarted = true;
          note = "Mirroring runs in the background. list_repositories shows each repository's status.";
        }

        return {
          added: !alreadyTracked,
          mirrorStarted,
          organization: summarizeOrganization(org),
          note,
        };
      })
  );

  server.registerTool(
    "sync_repositories",
    {
      title: "Sync repositories",
      description:
        "Pull the latest changes into repositories that are already mirrored. Runs in the background; check get_repository afterwards.",
      inputSchema: { repositoryIds: repositoryIdsSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ repositoryIds }) =>
      run(async () => {
        const { body } = await client.post<JobResponse>("/api/job/sync-repo", { repositoryIds });
        return summarizeJob(body);
      })
  );

  server.registerTool(
    "retry_repositories",
    {
      title: "Retry repositories",
      description:
        "Retry repositories that failed, or start ones that were added but never mirrored. A repository already on the destination is synced instead. Runs in the background.",
      inputSchema: { repositoryIds: repositoryIdsSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ repositoryIds }) =>
      run(async () => {
        const { body } = await client.post<JobResponse>("/api/job/retry-repo", { repositoryIds });
        return summarizeJob(body);
      })
  );
}
