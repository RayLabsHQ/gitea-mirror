import type { APIRoute } from "astro";
import { configs, db, repositories } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { and, eq, sql } from "drizzle-orm";
import { type Repository } from "@/lib/db/schema";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import type {
  AddRepositoriesApiRequest,
  AddRepositoriesApiResponse,
} from "@/types/Repository";
import { createMirrorJob } from "@/lib/helpers";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import {
  SOURCE_PROVIDER_LABELS,
  createSourceProviderFromConfig,
  describeSource,
  sourceHostOf,
} from "@/lib/source-providers";
import { repositorySourceColumns } from "@/lib/repo-utils";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: AddRepositoriesApiRequest = await request.json();
    const { owner, repo, force = false, destinationOrg, host, path } = body;

    if (!owner || !repo) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing owner or repo",
        }),
        { status: 400 }
      );
    }

    const trimmedOwner = owner.trim();
    const trimmedRepo = repo.trim();

    if (!trimmedOwner || !trimmedRepo) {
      return jsonResponse({
        data: {
          success: false,
          error: "Missing owner or repo",
        },
        status: 400,
      });
    }

    // Get user's active config — prefer active and most-recently-updated to avoid
    // picking a stale inactive stub when multiple rows exist (see issue #271).
    const [config] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    if (!config) {
      return jsonResponse({
        data: { error: "No configuration found for this user" },
        status: 404,
      });
    }

    const configId = config.id;

    // The configured source host. Without a token GitHub still allows public
    // lookups, so a missing token is not an error here.
    const sourceProvider = createSourceProviderFromConfig(config, { userId });
    const sourceConnection = sourceProvider.connection;
    const sourceLabel = SOURCE_PROVIDER_LABELS[sourceProvider.kind];

    // A pasted URL that names a different host cannot be served by this source.
    const configuredHost = sourceHostOf(sourceConnection.url);
    if (host && configuredHost && host.trim().toLowerCase() !== configuredHost) {
      return jsonResponse({
        data: {
          success: false,
          error: `That URL points at ${host}, but the configured source is ${describeSource(sourceConnection)}.`,
        },
        status: 400,
      });
    }

    // Prefer the pasted path segments: the source host knows how to split
    // them (GitLab nests groups, GitHub and Gitea do not).
    const resolvedPath =
      (Array.isArray(path) && path.length > 0
        ? sourceProvider.resolveRepositoryPath(path)
        : null) ?? { owner: trimmedOwner, repo: trimmedRepo };

    const normalizedFullName = `${resolvedPath.owner}/${resolvedPath.repo}`.toLowerCase();

    // Check if repository with the same owner, name, and userId already exists
    const [existingRepo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, userId),
          eq(repositories.normalizedFullName, normalizedFullName)
        )
      )
      .limit(1);

    if (existingRepo && !force) {
      return jsonResponse({
        data: {
          success: false,
          error:
            "Repository with this name and owner already exists for this user",
        },
        status: 409,
      });
    }

    const repoData = await sourceProvider.getRepository(resolvedPath.owner, resolvedPath.repo);
    if (!repoData) {
      return jsonResponse({
        data: {
          success: false,
          error: `Repository ${resolvedPath.owner}/${resolvedPath.repo} was not found on ${sourceLabel}`,
        },
        status: 404,
      });
    }

    const baseMetadata = {
      userId,
      configId,
      name: repoData.name,
      fullName: repoData.fullName,
      normalizedFullName: repoData.fullName.toLowerCase(),
      url: repoData.url,
      cloneUrl: repoData.cloneUrl,
      owner: repoData.owner,
      organization: repoData.organization ?? null,
      ...repositorySourceColumns(repoData),
      isPrivate: repoData.isPrivate,
      isForked: repoData.isForked,
      forkedFrom: repoData.forkedFrom ?? null,
      hasIssues: repoData.hasIssues,
      isStarred: false,
      isArchived: repoData.isArchived,
      size: repoData.size,
      hasLFS: repoData.hasLFS,
      hasSubmodules: repoData.hasSubmodules,
      language: repoData.language ?? null,
      description: repoData.description ?? null,
      defaultBranch: repoData.defaultBranch,
      visibility: repoData.visibility,
      lastMirrored: existingRepo?.lastMirrored ?? null,
      errorMessage: existingRepo?.errorMessage ?? null,
      mirroredLocation: existingRepo?.mirroredLocation ?? "",
      destinationOrg: destinationOrg?.trim() || existingRepo?.destinationOrg || null,
      updatedAt: repoData.updatedAt,
    };

    if (existingRepo && force) {
      const [updatedRepo] = await db
        .update(repositories)
        .set({
          ...baseMetadata,
          configId,
        })
        .where(eq(repositories.id, existingRepo.id))
        .returning();

      const resPayload: AddRepositoriesApiResponse = {
        success: true,
        repository: updatedRepo ?? existingRepo,
        message: "Repository already exists; metadata refreshed.",
      };

      return jsonResponse({ data: resPayload, status: 200 });
    }

    const metadata = {
      id: uuidv4(),
      status: "imported" as Repository["status"],
      lastMirrored: null,
      errorMessage: null,
      mirroredLocation: "",
      destinationOrg: null,
      importedAt: new Date(),
      createdAt: repoData.createdAt,
      ...baseMetadata,
    } satisfies Repository;

    await db
      .insert(repositories)
      .values(metadata)
      .onConflictDoNothing({ target: [repositories.userId, repositories.normalizedFullName] });

    createMirrorJob({
      userId,
      organizationId: metadata.organization,
      organizationName: metadata.organization,
      repositoryId: metadata.id,
      repositoryName: metadata.name,
      status: "imported",
      message: `Repository ${metadata.name} fetched successfully`,
      details: `Repository ${metadata.name} was fetched from ${sourceLabel}`,
    });

    const resPayload: AddRepositoriesApiResponse = {
      success: true,
      repository: metadata,
      message: "Repository added successfully",
    };

    return jsonResponse({ data: resPayload, status: 200 });
  } catch (error) {
    return createSecureErrorResponse(error, "repository sync", 500);
  }
};
