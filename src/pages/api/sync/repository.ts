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
  SourceApiError,
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

    // The source that serves this URL: when the request pastes a host, the
    // connected source whose host matches it; otherwise the primary source.
    // The URL shape cannot tell providers apart, so multiple sources on the
    // same host resolve to the primary one.
    const { listSources } = await import("@/lib/sources");
    const { createSourceProviderFromSource } = await import("@/lib/source-providers");
    const userSources = await listSources(userId);

    const pastedHost = host?.trim().toLowerCase() || "";
    let source = userSources[0];
    if (pastedHost) {
      const hostMatches = userSources.filter((s) => sourceHostOf(s.url) === pastedHost);
      if (hostMatches.length === 0) {
        return jsonResponse({
          data: {
            success: false,
            error: `No connected source matches host ${pastedHost}; add it on the Configuration page first`,
          },
          status: 400,
        });
      }
      source = hostMatches.includes(userSources[0]) ? userSources[0] : hostMatches[0];
    }

    if (!source) {
      return jsonResponse({
        data: {
          success: false,
          error: "No source is configured for this user; add one on the Configuration page first",
        },
        status: 400,
      });
    }

    // A missing token still allows public lookups on every provider.
    const sourceProvider = createSourceProviderFromSource(source, { userId });
    const sourceLabel = SOURCE_PROVIDER_LABELS[sourceProvider.kind];

    // Prefer the pasted path segments: the source host knows how to split
    // them (GitLab nests groups, GitHub and Gitea do not).
    const resolvedPath =
      (Array.isArray(path) && path.length > 0
        ? sourceProvider.resolveRepositoryPath(path)
        : null) ?? { owner: trimmedOwner, repo: trimmedRepo };

    const normalizedFullName = `${resolvedPath.owner}/${resolvedPath.repo}`.toLowerCase();

    // A repository is unique per source: the same full name under another
    // source is a different repository and may coexist.
    const [existingRepo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, userId),
          eq(repositories.sourceId, source.id),
          eq(repositories.normalizedFullName, normalizedFullName)
        )
      )
      .limit(1);

    // The 409 carries the stored record, so a client can go straight to
    // mirroring it without listing every repository to find the id.
    if (existingRepo && !force) {
      return jsonResponse({
        data: {
          success: false,
          error:
            "Repository with this name and owner already exists for this user",
          repository: existingRepo,
        },
        status: 409,
      });
    }

    let repoData: Awaited<ReturnType<typeof sourceProvider.getRepository>>;
    try {
      repoData = await sourceProvider.getRepository(resolvedPath.owner, resolvedPath.repo);
    } catch (error) {
      // A plain git host answers with a status and nothing else. Say what it
      // was instead of a generic server error, so a missing password or an
      // unreachable host can be told apart.
      if (sourceProvider.kind === "git" && error instanceof SourceApiError) {
        const refused = error.status === 401 || error.status === 403;
        return jsonResponse({
          data: {
            success: false,
            error: refused
              ? source.token
                ? `${sourceHostOf(source.url)} refused the username and password saved for this source`
                : `${sourceHostOf(source.url)} did not serve that repository without a login. Check the URL, or if the repository is private add a username and password to this source on the Configuration page`
              : `${sourceHostOf(source.url)} answered with status ${error.status} for that repository`,
          },
          status: refused ? 400 : 502,
        });
      }
      throw error;
    }
    if (!repoData) {
      return jsonResponse({
        data: {
          success: false,
          error:
            sourceProvider.kind === "git"
              ? `No git repository answered at that URL on ${sourceHostOf(source.url)}`
              : `Repository ${resolvedPath.owner}/${resolvedPath.repo} was not found on ${sourceLabel}`,
        },
        status: 404,
      });
    }

    const baseMetadata = {
      userId,
      configId,
      sourceId: source.id,
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
      .onConflictDoNothing({
        target: [repositories.userId, repositories.sourceId, repositories.normalizedFullName],
      });

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
