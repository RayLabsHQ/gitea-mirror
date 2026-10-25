import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, mirrorJobs, repositories } from "@/lib/db";

const MAX_LIMIT = 100;
export const mcpLimitSchema = z.number().int().min(1).max(MAX_LIMIT).default(25);
export const mcpRepositoryIdSchema = z.string().trim().min(1).max(200);

export interface McpServerContext {
  userId: string;
  scopes?: string[];
  db?: typeof defaultDb;
  dispatchSync?: (input: { userId: string; repositoryId: string; retry: boolean }) => Promise<unknown>;
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

  if (scopes.has("mirror:read")) {
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
    "List recent mirror and sync activity for the authenticated user. Results are capped at 100.",
    { limit: mcpLimitSchema },
    async ({ limit }) => {
      const activities = await database.select({
        id: mirrorJobs.id,
        repositoryId: mirrorJobs.repositoryId,
        repositoryName: mirrorJobs.repositoryName,
        status: mirrorJobs.status,
        message: mirrorJobs.message,
        timestamp: mirrorJobs.timestamp,
        jobType: mirrorJobs.jobType,
      }).from(mirrorJobs).where(eq(mirrorJobs.userId, context.userId))
        .orderBy(desc(mirrorJobs.timestamp)).limit(limit);
      return result({ activities });
    },
  );
  }

  if (scopes.has("mirror:sync")) {
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
