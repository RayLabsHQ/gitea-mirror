import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, mirrorJobs, repositories, organizations, configs } from "@/lib/db";
import { rateLimits, sources } from "@/lib/db/schema";
import { decryptConfigTokens } from "@/lib/utils/config-encryption";
import { httpGet } from "@/lib/http-client";

const MAX_LIMIT = 100;
export const mcpLimitSchema = z.number().int().min(1).max(MAX_LIMIT).default(25);
export const mcpRepositoryIdSchema = z.string().trim().min(1).max(200);
export const mcpMirrorOptionsSchema = z.object({
  mirrorInterval: z.string().trim().min(1).max(50).optional(),
  lfs: z.boolean().optional(), wiki: z.boolean().optional(),
  visibility: z.enum(["public", "private", "limited", "default"]).optional(),
  createOrg: z.boolean().optional(), addTopics: z.boolean().optional(), topicPrefix: z.string().max(100).optional(),
  preserveVisibility: z.boolean().optional(), preserveOrgStructure: z.boolean().optional(),
  forkStrategy: z.enum(["skip", "reference", "full-copy"]).optional(),
  issueConcurrency: z.number().int().min(1).max(100).optional(),
  pullRequestConcurrency: z.number().int().min(1).max(100).optional(),
  mirrorReleases: z.boolean().optional(), releaseLimit: z.number().int().min(0).max(1000).optional(),
  releaseAssetLimit: z.number().int().min(0).max(1000).nullable().optional(),
  releaseType: z.enum(["all", "stable"]).optional(),
  releaseIncludeTags: z.array(z.string().max(200)).max(100).optional(),
  releaseExcludeTags: z.array(z.string().max(200)).max(100).optional(),
  mirrorMetadata: z.boolean().optional(), mirrorIssues: z.boolean().optional(),
  mirrorPullRequests: z.boolean().optional(), mirrorLabels: z.boolean().optional(), mirrorMilestones: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0);
export const mcpMirrorOverrideSchema = z.object({
  lfs: z.boolean().nullable().optional(),
  wiki: z.boolean().nullable().optional(),
  mirrorReleases: z.boolean().nullable().optional(),
  mirrorMetadata: z.boolean().nullable().optional(),
  mirrorIssues: z.boolean().nullable().optional(),
  mirrorPullRequests: z.boolean().nullable().optional(),
  mirrorLabels: z.boolean().nullable().optional(),
  mirrorMilestones: z.boolean().nullable().optional(),
  releaseLimit: z.number().int().min(0).max(1000).nullable().optional(),
  releaseAssetLimit: z.number().int().min(0).max(1000).nullable().optional(),
  releaseType: z.enum(["all", "stable"]).nullable().optional(),
  releaseIncludeTags: z.array(z.string().max(200)).max(100).nullable().optional(),
  releaseExcludeTags: z.array(z.string().max(200)).max(100).nullable().optional(),
  skipForks: z.boolean().nullable().optional(),
}).strict().nullable();
export const mcpScheduleSchema = z.object({
  enabled: z.boolean().optional(), interval: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(), autoImport: z.boolean().optional(), autoMirror: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0);

export interface McpServerContext {
  userId: string;
  scopes?: string[];
  db?: typeof defaultDb;
  dispatchSync?: (input: { userId: string; repositoryId: string; retry: boolean }) => Promise<unknown>;
  dispatchOperation?: (input: { userId: string; operation: "sync-repositories" | "mirror-repositories" | "sync-organization" | "mirror-organizations" | "reset-metadata" | "move-repository" | "move-organization" | "reconcile" | "resolve-sync-alert" | "set-organization-status" | "set-organization-destination" | "set-organization-settings" | "set-repository-settings" | "set-repository-status" | "delete-repositories" | "delete-organization" | "import-repository" | "import-organization" | "refresh-repository-metadata"; ids?: string[]; id?: string; body?: Record<string, unknown> }) => Promise<unknown>;
}

function result(data: unknown) {
  return {
    structuredContent: data as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

/** Create an MCP tool registry bound to an already-authenticated user. */
export function createMcpServer(context: McpServerContext): McpServer {
  if (!context.userId) throw new Error("MCP context requires a userId");
  const database = context.db ?? defaultDb;
  const server = new McpServer({ name: "gitea-mirror", version: "1.0.0" });
  const scopes = new Set(context.scopes ?? ["mirror:read", "mirror:sync"]);
  const ownedRepo = (repositoryId: string) => database.select().from(repositories)
    .where(and(eq(repositories.id, repositoryId), eq(repositories.userId, context.userId))).limit(1);
  const ownedOrg = (organizationId: string) => database.select().from(organizations)
    .where(and(eq(organizations.id, organizationId), eq(organizations.userId, context.userId))).limit(1);
  const overrideInput = mcpMirrorOverrideSchema;

  if (scopes.has("mirror:read")) {

  server.tool("get_repository", "Get a repository owned by the authenticated user.",
    { repositoryId: mcpRepositoryIdSchema },
    async ({ repositoryId }) => {
      const [repository] = await database.select({ id: repositories.id, name: repositories.name, fullName: repositories.fullName, owner: repositories.owner, description: repositories.description, status: repositories.status, lastMirrored: repositories.lastMirrored, errorMessage: repositories.errorMessage, mirroredLocation: repositories.mirroredLocation, destinationOrg: repositories.destinationOrg, isPrivate: repositories.isPrivate, isArchived: repositories.isArchived, language: repositories.language, defaultBranch: repositories.defaultBranch, importedAt: repositories.importedAt, updatedAt: repositories.updatedAt })
        .from(repositories).where(and(eq(repositories.id, repositoryId), eq(repositories.userId, context.userId))).limit(1);
      return result(repository ? { repository } : { error: "Repository not found" });
    });
  server.tool("preview_tracked_repositories", "List already-tracked repositories available for release-rule previews; this does not discover source repositories.",
    { limit: mcpLimitSchema },
    async ({ limit }) => {
      const rows = await database.select({ id: repositories.id, name: repositories.name, owner: repositories.owner })
        .from(repositories).where(eq(repositories.userId, context.userId))
        .orderBy(asc(repositories.name)).limit(Math.min(limit, 200));
      return result({ repositories: rows.map(({ id, name, owner }) => ({ id, label: `${owner}/${name}` })) });
    });
  server.tool("preview_repository_releases", "Preview destination releases for an owned repository.",
    { repositoryId: mcpRepositoryIdSchema },
    async ({ repositoryId }) => {
      const [repository] = await ownedRepo(repositoryId);
      if (!repository) return result({ error: "Repository not found" });
      const [config] = await database.select().from(configs)
        .where(and(eq(configs.userId, context.userId), eq(configs.isActive, true))).limit(1);
      if (!config?.giteaConfig?.url || !config.giteaConfig.token) return result({ error: "No configured destination" });
      const location = (repository.mirroredLocation ?? "").trim();
      const [owner, repoName] = location.includes("/") ? location.split("/", 2) : [config.giteaConfig.defaultOwner, repository.name];
      try {
        const token = decryptConfigTokens(config as any).giteaConfig.token;
        const response = await httpGet<any[]>(
          `${config.giteaConfig.url.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/releases?per_page=100&page=1`,
          { Authorization: `token ${token}` },
        );
        const releases = Array.isArray(response.data) ? response.data.map((release) => ({
          tag: typeof release.tag_name === "string" ? release.tag_name : "",
          prerelease: typeof release.prerelease === "boolean" ? release.prerelease : null,
        })).filter((release) => release.tag) : [];
        return result({ destination: `${owner}/${repoName}`, releases, truncated: releases.length === 100 });
      } catch {
        return result({ error: "Could not read destination releases" });
      }
    });
  server.tool("list_organizations", "List organizations owned by the authenticated user.",
    { limit: mcpLimitSchema },
    async ({ limit }) => result({ organizations: await database.select({ id: organizations.id, name: organizations.name, avatarUrl: organizations.avatarUrl, membershipRole: organizations.membershipRole, isIncluded: organizations.isIncluded, destinationOrg: organizations.destinationOrg, status: organizations.status, lastMirrored: organizations.lastMirrored, errorMessage: organizations.errorMessage, repositoryCount: organizations.repositoryCount, publicRepositoryCount: organizations.publicRepositoryCount, privateRepositoryCount: organizations.privateRepositoryCount, forkRepositoryCount: organizations.forkRepositoryCount, updatedAt: organizations.updatedAt })
      .from(organizations).where(eq(organizations.userId, context.userId)).orderBy(sql`name COLLATE NOCASE`).limit(limit) }));
  server.tool("get_organization", "Get an organization owned by the authenticated user.",
    { organizationId: mcpRepositoryIdSchema },
    async ({ organizationId }) => {
      const [organization] = await database.select({ id: organizations.id, name: organizations.name, avatarUrl: organizations.avatarUrl, membershipRole: organizations.membershipRole, isIncluded: organizations.isIncluded, destinationOrg: organizations.destinationOrg, mirrorOverrides: organizations.mirrorOverrides, status: organizations.status, lastMirrored: organizations.lastMirrored, errorMessage: organizations.errorMessage, repositoryCount: organizations.repositoryCount, updatedAt: organizations.updatedAt })
        .from(organizations).where(and(eq(organizations.id, organizationId), eq(organizations.userId, context.userId))).limit(1);
      return result(organization ? { organization } : { error: "Organization not found" });
    });
  server.tool("preview_organization_repositories", "List an owned organization's repositories for preview.",
    { organizationId: mcpRepositoryIdSchema, limit: mcpLimitSchema },
    async ({ organizationId, limit }) => {
      const [organization] = await ownedOrg(organizationId);
      if (!organization) return result({ error: "Organization not found" });
      const rows = await database.select({ id: repositories.id, name: repositories.name, owner: repositories.owner })
        .from(repositories).where(and(eq(repositories.userId, context.userId), eq(repositories.organization, organization.name), organization.sourceId ? eq(repositories.sourceId, organization.sourceId) : sql`${repositories.sourceId} IS NULL`))
        .orderBy(asc(repositories.name)).limit(Math.min(limit, 200));
      return result({ organization: organization.name, repositories: rows.map(({ id, name, owner }) => ({ id, label: `${owner}/${name}` })) });
    });
  server.tool("get_organization_mirror_overrides", "Get mirror overrides for an organization owned by the caller.",
    { name: z.string().trim().min(1).max(200) },
    async ({ name }) => {
      const [organization] = await database.select({ name: organizations.name, mirrorOverrides: organizations.mirrorOverrides })
        .from(organizations).where(and(eq(organizations.userId, context.userId), eq(organizations.name, name))).limit(1);
      return result({ name, mirrorOverrides: organization?.mirrorOverrides ?? null });
    });
  server.tool("export_repositories", "Export the caller's repository records without internal IDs or secrets.",
    {},
    async () => {
      const rows = await database.select({ name: repositories.name, fullName: repositories.fullName, owner: repositories.owner, description: repositories.description, status: repositories.status, lastMirrored: repositories.lastMirrored, mirroredLocation: repositories.mirroredLocation, destinationOrg: repositories.destinationOrg, isPrivate: repositories.isPrivate, isArchived: repositories.isArchived, language: repositories.language, defaultBranch: repositories.defaultBranch, importedAt: repositories.importedAt, updatedAt: repositories.updatedAt }).from(repositories).where(eq(repositories.userId, context.userId))
        .orderBy(sql`${repositories.fullName} COLLATE NOCASE`);
      return result({ repositories: rows });
    });
  server.tool("export_organizations", "Export the caller's organization records without internal IDs.",
    {},
    async () => {
      const rows = await database.select({ name: organizations.name, membershipRole: organizations.membershipRole, isIncluded: organizations.isIncluded, destinationOrg: organizations.destinationOrg, status: organizations.status, lastMirrored: organizations.lastMirrored, repositoryCount: organizations.repositoryCount, updatedAt: organizations.updatedAt }).from(organizations).where(eq(organizations.userId, context.userId))
        .orderBy(sql`${organizations.name} COLLATE NOCASE`);
      return result({ organizations: rows });
    });
  server.tool("get_dashboard_summary", "Get a summary of the caller's mirror dashboard.",
    {},
    async () => {
      const [repoRows, orgRows, activities] = await Promise.all([
        database.select({ id: repositories.id, fullName: repositories.fullName, status: repositories.status, lastMirrored: repositories.lastMirrored, updatedAt: repositories.updatedAt }).from(repositories).where(eq(repositories.userId, context.userId)).orderBy(desc(repositories.updatedAt)).limit(10),
        database.select({ id: organizations.id, name: organizations.name, status: organizations.status, repositoryCount: organizations.repositoryCount, updatedAt: organizations.updatedAt }).from(organizations).where(eq(organizations.userId, context.userId)).orderBy(desc(organizations.updatedAt)).limit(10),
        database.select({ id: mirrorJobs.id, repositoryName: mirrorJobs.repositoryName, organizationName: mirrorJobs.organizationName, status: mirrorJobs.status, message: mirrorJobs.message, timestamp: mirrorJobs.timestamp, jobType: mirrorJobs.jobType }).from(mirrorJobs).where(eq(mirrorJobs.userId, context.userId)).orderBy(desc(mirrorJobs.timestamp)).limit(10),
      ]);
      return result({ repositories: repoRows, organizations: orgRows, activities, repositoryCount: repoRows.length, organizationCount: orgRows.length });
    });

  server.tool(
    "list_repositories",
    "List repositories owned by the authenticated user, optionally filtered by mirror status. Results are capped at 100.",
    { status: z.string().trim().min(1).max(40).optional(), limit: mcpLimitSchema },
    async ({ status, limit }) => {
      const filters = [eq(repositories.userId, context.userId)];
      if (status) filters.push(eq(repositories.status, status));
      const rows = await database.select({
        id: repositories.id,
        name: repositories.name,
        fullName: repositories.fullName,
        status: repositories.status,
        lastMirrored: repositories.lastMirrored,
        errorMessage: repositories.errorMessage,
      }).from(repositories).where(and(...filters)).orderBy(desc(repositories.updatedAt)).limit(limit);
      return result({ repositories: rows });
    },
  );

  server.tool(
    "get_repository_status",
    "Get status and recent activity for one repository owned by the authenticated user.",
    { repositoryId: mcpRepositoryIdSchema, activityLimit: mcpLimitSchema },
    async ({ repositoryId, activityLimit }) => {
      const [repository] = await database.select({
        id: repositories.id,
        fullName: repositories.fullName,
        status: repositories.status,
        lastMirrored: repositories.lastMirrored,
        errorMessage: repositories.errorMessage,
      }).from(repositories).where(and(
        eq(repositories.id, repositoryId),
        eq(repositories.userId, context.userId),
      )).limit(1);
      if (!repository) return result({ error: "Repository not found" });
      const activities = await database.select({
        id: mirrorJobs.id,
        status: mirrorJobs.status,
        message: mirrorJobs.message,
        timestamp: mirrorJobs.timestamp,
        jobType: mirrorJobs.jobType,
      }).from(mirrorJobs).where(and(
        eq(mirrorJobs.userId, context.userId),
        eq(mirrorJobs.repositoryId, repositoryId),
      )).orderBy(desc(mirrorJobs.timestamp)).limit(activityLimit);
      return result({ repository, activities });
    },
  );

  server.tool(
    "list_activities",
    "List caller-owned activity with optional status, job, repo, organization and timestamp filters.",
    {
      limit: mcpLimitSchema,
      offset: z.number().int().min(0).max(100000).default(0),
      status: z.string().trim().min(1).max(40).optional(),
      jobType: z.enum(["mirror", "cleanup", "import"]).optional(),
      repositoryId: mcpRepositoryIdSchema.optional(),
      organizationId: mcpRepositoryIdSchema.optional(),
      since: z.coerce.date().optional(),
      until: z.coerce.date().optional(),
    },
    async ({ limit, offset, status, jobType, repositoryId, organizationId, since, until }) => {
      if (repositoryId) { const [owned] = await ownedRepo(repositoryId); if (!owned) return result({ error: "Repository not found" }); }
      if (organizationId) { const [owned] = await ownedOrg(organizationId); if (!owned) return result({ error: "Organization not found" }); }
      const filters = [eq(mirrorJobs.userId, context.userId)];
      if (status) filters.push(eq(mirrorJobs.status, status));
      if (jobType) filters.push(eq(mirrorJobs.jobType, jobType));
      if (repositoryId) filters.push(eq(mirrorJobs.repositoryId, repositoryId));
      if (organizationId) filters.push(eq(mirrorJobs.organizationId, organizationId));
      if (since) filters.push(sql`${mirrorJobs.timestamp} >= ${since}`);
      if (until) filters.push(sql`${mirrorJobs.timestamp} <= ${until}`);
      const activities = await database.select({
        id: mirrorJobs.id,
        repositoryId: mirrorJobs.repositoryId,
        repositoryName: mirrorJobs.repositoryName,
        status: mirrorJobs.status,
        message: mirrorJobs.message,
        timestamp: mirrorJobs.timestamp,
        jobType: mirrorJobs.jobType,
      }).from(mirrorJobs).where(and(...filters))
        .orderBy(desc(mirrorJobs.timestamp)).limit(limit).offset(offset);
      return result({ activities, limit, offset });
    },
  );
  server.tool("get_provider_rate_limit", "Get the caller's most recent stored provider rate-limit information.",
    { provider: z.enum(["github", "gitea"]).default("github") },
    async ({ provider }) => {
      const [rateLimit] = await database.select().from(rateLimits)
        .where(and(eq(rateLimits.userId, context.userId), eq(rateLimits.provider, provider)))
        .orderBy(desc(rateLimits.updatedAt)).limit(1);
      return result({ rateLimit: rateLimit ? { provider: rateLimit.provider, limit: rateLimit.limit, remaining: rateLimit.remaining, used: rateLimit.used, reset: rateLimit.reset, retryAfter: rateLimit.retryAfter, updatedAt: rateLimit.updatedAt } : null });
    });
  server.tool("list_starred_lists", "List saved starred-list names from the caller's active configuration.",
    {},
    async () => {
      const [config] = await database.select({ githubConfig: configs.githubConfig })
        .from(configs).where(and(eq(configs.userId, context.userId), eq(configs.isActive, true))).limit(1);
      return result({ lists: config?.githubConfig?.starredLists ?? [] });
    });
  server.tool("preview_organization_mirror_move", "Preview the repositories affected by changing an owned organization's destination.",
    { organizationId: mcpRepositoryIdSchema, destinationOrg: z.string().trim().max(100).nullable().optional() },
    async ({ organizationId, destinationOrg }) => {
      const [organization] = await ownedOrg(organizationId);
      if (!organization) return result({ error: "Organization not found" });
      const rows = await database.select({ id: repositories.id, fullName: repositories.fullName, status: repositories.status, mirroredLocation: repositories.mirroredLocation, destinationOrg: repositories.destinationOrg })
        .from(repositories).where(and(eq(repositories.userId, context.userId), eq(repositories.organization, organization.name), organization.sourceId ? eq(repositories.sourceId, organization.sourceId) : sql`${repositories.sourceId} IS NULL`));
      const target = destinationOrg || null;
      return result({ organization: organization.name, destinationOrg: target,
        repositories: rows.map((repository) => ({ ...repository, outcome: repository.destinationOrg ? "skipped-repository-override" : repository.status !== "mirrored" && repository.status !== "synced" ? "not-mirrored" : "would-move" })) });
    });
  server.tool("get_mirror_configuration", "Get non-secret mirror settings from the caller's active configuration.",
    {},
    async () => {
      const [config] = await database.select().from(configs)
        .where(and(eq(configs.userId, context.userId), eq(configs.isActive, true))).limit(1);
      if (!config) return result({ error: "No active configuration found" });
      return result({ configuration: {
        name: config.name, source: { provider: config.githubConfig.provider, owner: config.githubConfig.owner },
        destination: { provider: config.giteaConfig.provider, defaultOwner: config.giteaConfig.defaultOwner, organization: config.giteaConfig.organization },
        mirrorOptions: {
          mirrorInterval: config.giteaConfig.mirrorInterval, lfs: config.giteaConfig.lfs, wiki: config.giteaConfig.wiki,
          visibility: config.giteaConfig.visibility, createOrg: config.giteaConfig.createOrg, addTopics: config.giteaConfig.addTopics,
          preserveVisibility: config.giteaConfig.preserveVisibility, preserveOrgStructure: config.giteaConfig.preserveOrgStructure,
          forkStrategy: config.giteaConfig.forkStrategy, mirrorReleases: config.giteaConfig.mirrorReleases,
          releaseLimit: config.giteaConfig.releaseLimit, releaseAssetLimit: config.giteaConfig.releaseAssetLimit,
          releaseType: config.giteaConfig.releaseType, releaseIncludeTags: config.giteaConfig.releaseIncludeTags,
          releaseExcludeTags: config.giteaConfig.releaseExcludeTags, mirrorMetadata: config.giteaConfig.mirrorMetadata,
          mirrorIssues: config.giteaConfig.mirrorIssues, mirrorPullRequests: config.giteaConfig.mirrorPullRequests,
          mirrorLabels: config.giteaConfig.mirrorLabels, mirrorMilestones: config.giteaConfig.mirrorMilestones,
        },
        schedule: { enabled: config.scheduleConfig.enabled, interval: config.scheduleConfig.interval, timezone: config.scheduleConfig.timezone, autoImport: config.scheduleConfig.autoImport, autoMirror: config.scheduleConfig.autoMirror },
      } });
    });
  }

  if (scopes.has("mirror:settings")) {
    const idList = z.array(mcpRepositoryIdSchema).min(1).max(100);
    const repoInput = z.object({ repositoryId: mcpRepositoryIdSchema });
    const repoSetting = (name: string, fields: z.ZodRawShape, update: (input: any) => Record<string, unknown>) => {
      server.tool(name, `Update settings for a caller-owned repository.`, { ...fields, repositoryId: mcpRepositoryIdSchema }, async (input: any) => {
        const [owned] = await ownedRepo(input.repositoryId);
        if (!owned) return result({ error: "Repository not found" });
        if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
        return result(await context.dispatchOperation({ userId: context.userId, operation: "set-repository-settings", ids: [input.repositoryId], body: update(input) }));
      });
    };
    server.tool("set_repository_status", "Set an owned repository status to imported or ignored.", { repositoryId: mcpRepositoryIdSchema, status: z.enum(["imported", "ignored"]) }, async ({ repositoryId, status }) => {
      const [owned] = await ownedRepo(repositoryId); if (!owned) return result({ error: "Repository not found" });
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      return result(await context.dispatchOperation({ userId: context.userId, operation: "set-repository-status", ids: [repositoryId], body: { status } }));
    });
    repoSetting("update_repository_settings", { destinationOrg: z.string().trim().max(100).nullable().optional() }, (i) => ({ ...(i.destinationOrg !== undefined ? { destinationOrg: i.destinationOrg || null } : {}) }));
    repoSetting("update_repository_mirror_overrides", { mirrorOverrides: overrideInput }, (i) => ({ mirrorOverrides: i.mirrorOverrides }));
    server.tool("delete_repositories", "Delete caller-owned repository records through the application's cleanup route; explicit confirmation required.", { repositoryIds: idList, confirm: z.literal(true) }, async ({ repositoryIds }) => {
      for (const repositoryId of repositoryIds) { const [owned] = await ownedRepo(repositoryId); if (!owned) return result({ error: "Repository not found" }); }
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      return result(await context.dispatchOperation({ userId: context.userId, operation: "delete-repositories", ids: repositoryIds }));
    });
    server.tool("delete_organization", "Delete an owned organization and its associated repository records using application cleanup semantics; confirmation required.", { organizationId: mcpRepositoryIdSchema, confirm: z.literal(true) }, async ({ organizationId }) => {
      const [owned] = await ownedOrg(organizationId);
      if (!owned) return result({ error: "Organization not found" });
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      return result(await context.dispatchOperation({ userId: context.userId, operation: "delete-organization", ids: [organizationId] }));
    });
  }
  if (scopes.has("mirror:sync")) {
    server.tool("import_repository", "Import a repository using the caller's connected source resolution. Set confirm true to refresh an existing record after its duplicate response.", {
      owner: z.string().trim().min(1).max(200), repo: z.string().trim().min(1).max(200),
      host: z.string().trim().max(255).optional(), path: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
      destinationOrg: z.string().trim().max(100).optional(), confirm: z.literal(true).optional(),
    }, async ({ owner, repo, host, path, destinationOrg, confirm }) => {
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      return result(await context.dispatchOperation({ userId: context.userId, operation: "import-repository", body: { owner, repo, host, path, destinationOrg, force: confirm === true } }));
    });
    server.tool("import_organization", "Import a public or connected-source organization; confirm true re-imports duplicates.", {
      org: z.string().trim().min(1).max(200), sourceId: mcpRepositoryIdSchema.optional(),
      provider: z.enum(["github", "gitlab", "gitea"]).optional(), sourceUrl: z.string().url().max(500).optional(),
      confirm: z.literal(true).optional(),
    }, async ({ org, sourceId, provider, sourceUrl, confirm }) => {
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      return result(await context.dispatchOperation({ userId: context.userId, operation: "import-organization", body: { org, sourceId, provider, sourceUrl, force: confirm === true } }));
    });
    const orgTool = (name: string, fields: z.ZodRawShape, update: (input: any) => Record<string, unknown>) => server.tool(name, "Update settings for a caller-owned organization.", { ...fields, organizationId: mcpRepositoryIdSchema }, async (input: any) => {
      const [owned] = await ownedOrg(input.organizationId); if (!owned) return result({ error: "Organization not found" });
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      return result(await context.dispatchOperation({ userId: context.userId, operation: "set-organization-settings", ids: [input.organizationId], body: update(input) }));
    });
    orgTool("update_organization_mirror_overrides", { mirrorOverrides: overrideInput }, (i) => ({ mirrorOverrides: i.mirrorOverrides }));
    server.tool("set_organization_destination", "Set destination through the application's organization update route.", { organizationId: mcpRepositoryIdSchema, destinationOrg: z.string().trim().max(100).nullable() }, async ({ organizationId, destinationOrg }) => {
      const [owned] = await ownedOrg(organizationId); if (!owned) return result({ error: "Organization not found" });
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      return result(await context.dispatchOperation({ userId: context.userId, operation: "set-organization-settings", ids: [organizationId], body: { destinationOrg } }));
    });
    server.tool("set_organization_source", "Pin a caller-owned organization to one of the caller's sources.", { organizationId: mcpRepositoryIdSchema, sourceId: mcpRepositoryIdSchema.nullable() }, async ({ organizationId, sourceId }) => {
      const [owned] = await ownedOrg(organizationId); if (!owned) return result({ error: "Organization not found" });
      if (sourceId) { const [source] = await database.select({ id: sources.id }).from(sources).where(and(eq(sources.id, sourceId), eq(sources.userId, context.userId))).limit(1); if (!source) return result({ error: "Source not found" }); }
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      return result(await context.dispatchOperation({ userId: context.userId, operation: "set-organization-settings", ids: [organizationId], body: { sourceId } }));
    });
    // Organization deletion has application-specific repository cleanup semantics; do not bypass them with a direct DB delete.
    server.tool("update_mirror_configuration", "Update selected allowlisted non-secret mirror settings for the caller.", { mirrorOptions: mcpMirrorOptionsSchema }, async ({ mirrorOptions }) => {
      const [config] = await database.select().from(configs).where(and(eq(configs.userId, context.userId), eq(configs.isActive, true))).limit(1);
      if (!config) return result({ error: "No active configuration found" });
      const [updated] = await database.update(configs).set({ giteaConfig: { ...config.giteaConfig, ...mirrorOptions } }).where(and(eq(configs.id, config.id), eq(configs.userId, context.userId))).returning({ id: configs.id }); return result({ updated: !!updated });
    });
    server.tool("update_schedule_configuration", "Update safe automation schedule preferences; no credentials or endpoints are accepted.", { schedule: mcpScheduleSchema }, async ({ schedule }) => {
      const [config] = await database.select().from(configs).where(and(eq(configs.userId, context.userId), eq(configs.isActive, true))).limit(1);
      if (!config) return result({ error: "No active configuration found" });
      const [updated] = await database.update(configs).set({ scheduleConfig: { ...config.scheduleConfig, ...schedule } }).where(and(eq(configs.id, config.id), eq(configs.userId, context.userId))).returning({ id: configs.id });
      return result({ updated: !!updated });
    });
    server.tool("refresh_repository_metadata", "Force-refresh metadata for an already-owned repository through the source import route.", { repositoryId: mcpRepositoryIdSchema, confirm: z.literal(true) }, async ({ repositoryId }) => {
      const [owned] = await ownedRepo(repositoryId);
      if (!owned) return result({ error: "Repository not found" });
      if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
      const [source] = owned.sourceId ? await database.select({ id: sources.id, url: sources.url, provider: sources.provider }).from(sources).where(and(eq(sources.id, owned.sourceId), eq(sources.userId, context.userId))).limit(1) : [];
      if (!source) return result({ error: "Repository source not found" });
      let host: string;
      try { host = new URL(source.url).host; } catch { return result({ error: "Repository source URL is invalid" }); }
      return result(await context.dispatchOperation({ userId: context.userId, operation: "refresh-repository-metadata", ids: [repositoryId], body: { owner: owned.owner, repo: owned.name, sourceId: source.id, provider: source.provider, force: true, host, path: owned.fullName.split("/") } }));
    });
  }

  if (scopes.has("mirror:sync")) {
  const dispatchOperation = async (operation: Parameters<NonNullable<McpServerContext["dispatchOperation"]>>[0]["operation"], ids: string[], body?: Record<string, unknown>) => {
    if (!context.dispatchOperation) return result({ error: "Operation dispatcher is unavailable" });
    for (const id of ids) {
      const [repo] = await ownedRepo(id);
      const [org] = await ownedOrg(id);
      if (!repo && !org) return result({ error: "Target not found" });
    }
    const response = await context.dispatchOperation({ userId: context.userId, operation, ids, body });
    return result({ accepted: true, operation, result: response });
  };
  const batchIds = z.array(mcpRepositoryIdSchema).min(1).max(25);
  server.tool("sync_repositories", "Queue sync jobs for up to 25 owned repositories.", { repositoryIds: batchIds }, ({ repositoryIds }) => dispatchOperation("sync-repositories", repositoryIds));
  server.tool("mirror_repositories", "Queue mirror jobs for up to 25 owned repositories.", { repositoryIds: batchIds }, ({ repositoryIds }) => dispatchOperation("mirror-repositories", repositoryIds));
  server.tool("sync_organization", "Sync an owned organization and its repositories.", { organizationId: mcpRepositoryIdSchema }, ({ organizationId }) => dispatchOperation("sync-organization", [organizationId]));
  server.tool("mirror_organization", "Mirror an owned organization.", { organizationId: mcpRepositoryIdSchema }, ({ organizationId }) => dispatchOperation("mirror-organizations", [organizationId]));
  server.tool("reset_repository_metadata", "Reset metadata state for owned repositories; confirmation required.", { repositoryIds: batchIds, confirm: z.literal(true) }, ({ repositoryIds }) => dispatchOperation("reset-metadata", repositoryIds));
  server.tool("resolve_sync_alert", "Approve or dismiss force-push alerts for owned repositories.", { repositoryIds: batchIds, action: z.enum(["approve", "dismiss"]), confirm: z.literal(true) }, ({ repositoryIds, action }) => dispatchOperation("resolve-sync-alert", repositoryIds, { action }));
  server.tool("set_organization_status_with_cascade", "Set an owned organization's status; optionally apply the UI's repository cascade. Ignoring with cascade requires confirmation.", { organizationId: mcpRepositoryIdSchema, status: z.enum(["imported", "ignored"]), cascade: z.boolean().default(false), confirm: z.literal(true).optional() }, ({ organizationId, status, cascade, confirm }) => {
    if (status === "ignored" && cascade && confirm !== true) return result({ error: "Confirmation required" });
    return dispatchOperation("set-organization-status", [organizationId], { status, cascade });
  });
  server.tool("move_repository_mirror", "Move an owned repository mirror; confirmation required.", { repositoryId: mcpRepositoryIdSchema, destinationOwner: z.string().trim().min(1).max(100), confirm: z.literal(true) }, ({ repositoryId, destinationOwner }) => dispatchOperation("move-repository", [repositoryId], { destinationOwner }));
  server.tool("move_organization_mirrors", "Preview or move an owned organization's mirrors. Execution requires confirmation.", { organizationId: mcpRepositoryIdSchema, destinationOrg: z.string().trim().max(100).nullable().optional(), dryRun: z.boolean().default(true), confirm: z.literal(true).optional() }, ({ organizationId, destinationOrg, dryRun, confirm }) => {
    if (!dryRun && confirm !== true) return result({ error: "Confirmation required" });
    return dispatchOperation("move-organization", [organizationId], { destinationOrg, dryRun });
  });
  server.tool("reconcile_destination", "Reconcile destination state. Apply requires explicit confirmation.", { dryRun: z.boolean().default(true), adoptUntracked: z.boolean().default(false), resetMissing: z.boolean().default(false), relocateMoved: z.boolean().default(false), confirm: z.literal(true).optional() }, (input) => {
    if (!input.dryRun && input.confirm !== true) return result({ error: "Confirmation required" });
    return dispatchOperation("reconcile", [], input);
  });
  const dispatch = (retry: boolean) => async ({ repositoryId }: { repositoryId: string }) => {
    if (!context.dispatchSync) return result({ error: "Sync dispatch is unavailable" });
    const [repository] = await database.select({ id: repositories.id }).from(repositories)
      .where(and(eq(repositories.id, repositoryId), eq(repositories.userId, context.userId))).limit(1);
    if (!repository) return result({ error: "Repository not found" });
    return result({ accepted: true, result: await context.dispatchSync({
      userId: context.userId, repositoryId, retry,
    }) });
  };

  server.tool(
    "sync_repository",
    "Queue a sync for a repository owned by the authenticated user through the host application's safe sync dispatcher.",
    { repositoryId: mcpRepositoryIdSchema },
    dispatch(false),
  );
  server.tool(
    "retry_repository_sync",
    "Queue a retry for a repository owned by the authenticated user through the host application's safe sync dispatcher.",
    { repositoryId: mcpRepositoryIdSchema },
    dispatch(true),
  );
  }

  return server;
}
