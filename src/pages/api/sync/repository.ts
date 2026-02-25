import type { APIRoute } from "astro";
import { Octokit } from "@octokit/rest";
import { configs, db, repositories } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { type Repository } from "@/lib/db/schema";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import type {
  AddRepositoriesApiRequest,
  AddRepositoriesApiResponse,
  RepositoryVisibility,
} from "@/types/Repository";
import { createMirrorJob } from "@/lib/helpers";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: AddRepositoriesApiRequest = await request.json();
    const { owner, repo, force = false } = body;

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

    const normalizedOwner = trimmedOwner.toLowerCase();
    const normalizedRepo = trimmedRepo.toLowerCase();
    const normalizedFullName = `${normalizedOwner}/${normalizedRepo}`;

    // Check if repository already exists for this user
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

    // Get user's active config
    const [config] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    if (!config) {
      return jsonResponse({
        data: { error: "No configuration found for this user" },
        status: 404,
      });
    }

    const configId = config.id;

    const octokit = new Octokit(); // No auth for public repos

    const { data: repoData } = await octokit.rest.repos.get({
      owner: trimmedOwner,
      repo: trimmedRepo,
    });

    const baseMetadata = {
      userId,
      configId,
      name: repoData.name,
      fullName: repoData.full_name,
      normalizedFullName,
      url: repoData.html_url,
      cloneUrl: repoData.clone_url,
      owner: repoData.owner.login,
      organization:
        repoData.owner.type === "Organization" ? repoData.owner.login : null,
      isPrivate: repoData.private,
      isForked: repoData.fork,
      forkedFrom: null,
      hasIssues: repoData.has_issues,
      isStarred: false,
      isArchived: repoData.archived,
      size: repoData.size,
      hasLFS: false,
      hasSubmodules: false,
      language: repoData.language ?? null,
      description: repoData.description ?? null,
      defaultBranch: repoData.default_branch,
      visibility: (repoData.visibility ?? "public") as RepositoryVisibility,
      lastMirrored: existingRepo?.lastMirrored ?? null,
      errorMessage: existingRepo?.errorMessage ?? null,
      mirroredLocation: existingRepo?.mirroredLocation ?? "",
      destinationOrg: existingRepo?.destinationOrg ?? null,
      updatedAt: repoData.updated_at
        ? new Date(repoData.updated_at)
        : new Date(),
    };

    if (existingRepo) {
      // Update existing repository with latest GitHub data
      const [updatedRepo] = await db
        .update(repositories)
        .set({
          ...baseMetadata,
          normalizedFullName,
          configId,
        })
        .where(eq(repositories.id, existingRepo.id))
        .returning();

      const resPayload: AddRepositoriesApiResponse = {
        success: true,
        repository: updatedRepo ?? existingRepo,
        message: force
          ? "Repository already exists; metadata refreshed."
          : "Repository updated with latest GitHub data.",
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
      createdAt: repoData.created_at
        ? new Date(repoData.created_at)
        : new Date(),
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
      details: `Repository ${metadata.name} was fetched from GitHub`,
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
