import type { APIRoute } from "astro";
import { configs, db, organizations, repositories } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import type {
  AddOrganizationApiRequest,
  AddOrganizationApiResponse,
} from "@/types/organizations";
import type { RepositoryVisibility, RepoStatus } from "@/types/Repository";
import { v4 as uuidv4 } from "uuid";
import { decryptConfigTokens } from "@/lib/utils/config-encryption";
import { createGitHubClient } from "@/lib/github";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: AddOrganizationApiRequest = await request.json();
    const { role, org, force = false } = body;

    if (!org || !role) {
      return jsonResponse({
        data: { success: false, error: "Missing org or role" },
        status: 400,
      });
    }

    const trimmedOrg = org.trim();
    const normalizedOrg = trimmedOrg.toLowerCase();

    // Check if org already exists (case-insensitive)
    const [existingOrg] = await db
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.userId, userId),
          eq(organizations.normalizedName, normalizedOrg)
        )
      )
      .limit(1);

    if (existingOrg && !force) {
      return jsonResponse({
        data: {
          success: false,
          error: "Organization already exists for this user",
        },
        status: 409,
      });
    }

    if (existingOrg && force) {
      const [updatedOrg] = await db
        .update(organizations)
        .set({
          membershipRole: role,
          normalizedName: normalizedOrg,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, existingOrg.id))
        .returning();

      const resPayload: AddOrganizationApiResponse = {
        success: true,
        organization: updatedOrg ?? existingOrg,
        message: "Organization already exists; using existing record.",
      };

      return jsonResponse({ data: resPayload, status: 200 });
    }

    if (existingOrg) {
      return jsonResponse({
        data: {
          success: false,
          error: "Organization already exists for this user",
        },
        status: 409,
      });
    }

    // Get user's config
    const [config] = await db
      .select()
      .from(configs)
      .where(and(eq(configs.userId, userId), eq(configs.isActive, true)))
      .limit(1);

    if (!config) {
      return jsonResponse({
        data: { error: "No active configuration found for this user" },
        status: 404,
      });
    }

    const configId = config.id;
    
    // Decrypt the config to get tokens
    const decryptedConfig = decryptConfigTokens(config);
    
    // Check if we have a GitHub token
    if (!decryptedConfig.githubConfig?.token) {
      return jsonResponse({
        data: { error: "GitHub token not configured" },
        status: 401,
      });
    }
    
    // Create authenticated Octokit instance with rate limit tracking
    const githubUsername = decryptedConfig.githubConfig?.owner || undefined;
    const octokit = createGitHubClient(
      decryptedConfig.githubConfig.token,
      userId,
      githubUsername
    );

    // Fetch org metadata
    const { data: orgData } = await octokit.orgs.get({ org: trimmedOrg });

    // Fetch repos based on config settings
    const allRepos = [];
    
    // Fetch all repos (public, private, and member) to show in UI
    const publicRepos = await octokit.paginate(octokit.repos.listForOrg, {
      org: trimmedOrg,
      type: "public",
      per_page: 100,
    });
    allRepos.push(...publicRepos);
    
    // Always fetch private repos to show them in the UI
    const privateRepos = await octokit.paginate(octokit.repos.listForOrg, {
      org: trimmedOrg,
      type: "private",
      per_page: 100,
    });
    allRepos.push(...privateRepos);
    
    // Also fetch member repos (includes private repos the user has access to)
    const memberRepos = await octokit.paginate(octokit.repos.listForOrg, {
      org: trimmedOrg,
      type: "member",
      per_page: 100,
    });
    // Filter out duplicates
    const existingIds = new Set(allRepos.map(r => r.id));
    const uniqueMemberRepos = memberRepos.filter(r => !existingIds.has(r.id));
    allRepos.push(...uniqueMemberRepos);

    // Insert repositories
    const repoRecords = allRepos.map((repo) => {
      const normalizedOwner = repo.owner.login.trim().toLowerCase();
      const normalizedRepoName = repo.name.trim().toLowerCase();

      return {
        id: uuidv4(),
        userId,
        configId,
        name: repo.name,
        fullName: repo.full_name,
        normalizedFullName: `${normalizedOwner}/${normalizedRepoName}`,
        url: repo.html_url,
        cloneUrl: repo.clone_url ?? "",
        owner: repo.owner.login,
        organization:
          repo.owner.type === "Organization" ? repo.owner.login : null,
        mirroredLocation: "",
        destinationOrg: null,
        isPrivate: repo.private,
        isForked: repo.fork,
        forkedFrom: null,
        hasIssues: repo.has_issues,
        isStarred: false,
        isArchived: repo.archived,
        size: repo.size,
        hasLFS: false,
        hasSubmodules: false,
        language: repo.language ?? null,
        description: repo.description ?? null,
        defaultBranch: repo.default_branch ?? "main",
        visibility: (repo.visibility ?? "public") as RepositoryVisibility,
        status: "imported" as RepoStatus,
        lastMirrored: null,
        errorMessage: null,
        createdAt: repo.created_at ? new Date(repo.created_at) : new Date(),
        updatedAt: repo.updated_at ? new Date(repo.updated_at) : new Date(),
      };
    });

    // Batch insert new repositories and update existing ones
    // Compute batch size based on column count
    const sample = repoRecords[0];
    const columnCount = Object.keys(sample ?? {}).length || 1;
    const BATCH_SIZE = Math.max(1, Math.floor(999 / columnCount));

    // Get existing repos for this user
    const existingRepos = await db
      .select({ normalizedFullName: repositories.normalizedFullName })
      .from(repositories)
      .where(eq(repositories.userId, userId));
    const existingRepoNames = new Set(existingRepos.map((r) => r.normalizedFullName));

    // Insert new repos
    const newRepos = repoRecords.filter((r) => !existingRepoNames.has(r.normalizedFullName));
    for (let i = 0; i < newRepos.length; i += BATCH_SIZE) {
      const batch = newRepos.slice(i, i + BATCH_SIZE);
      await db
        .insert(repositories)
        .values(batch)
        .onConflictDoNothing({ target: [repositories.userId, repositories.normalizedFullName] });
    }

    // Update existing repos with latest GitHub data
    const reposToUpdate = repoRecords.filter((r) => existingRepoNames.has(r.normalizedFullName));
    for (const repo of reposToUpdate) {
      await db
        .update(repositories)
        .set({
          description: repo.description,
          visibility: repo.visibility,
          isArchived: repo.isArchived,
          isPrivate: repo.isPrivate,
          size: repo.size,
          language: repo.language,
          defaultBranch: repo.defaultBranch,
          hasIssues: repo.hasIssues,
          updatedAt: new Date(),
        })
        .where(eq(repositories.normalizedFullName, repo.normalizedFullName));
    }

    // Insert organization metadata
    const organizationRecord = {
      id: uuidv4(),
      userId,
      configId,
      name: orgData.login,
      normalizedName: normalizedOrg,
      avatarUrl: orgData.avatar_url,
      membershipRole: role,
      isIncluded: false,
      status: "imported" as RepoStatus,
      repositoryCount: allRepos.length,
      createdAt: orgData.created_at ? new Date(orgData.created_at) : new Date(),
      updatedAt: orgData.updated_at ? new Date(orgData.updated_at) : new Date(),
    };

    await db.insert(organizations).values(organizationRecord);

    const resPayload: AddOrganizationApiResponse = {
      success: true,
      organization: organizationRecord,
      message: "Organization and repositories imported successfully",
    };

    return jsonResponse({ data: resPayload, status: 200 });
  } catch (error) {
    return createSecureErrorResponse(error, "organization sync", 500);
  }
};
