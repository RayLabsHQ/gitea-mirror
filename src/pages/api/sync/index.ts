import type { APIRoute } from "astro";
import { db, organizations, repositories, configs } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createMirrorJob } from "@/lib/helpers";
import {
  createGitHubClient,
  getGithubOrganizations,
  getGithubRepositories,
  getGithubStarredRepositories,
} from "@/lib/github";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { mergeGitReposPreferStarred, calcBatchSizeForInsert } from "@/lib/repo-utils";
import { getDecryptedGitHubToken } from "@/lib/utils/config-encryption";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { isMirrorableGitHubRepo } from "@/lib/repo-eligibility";

export const POST: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAuthenticatedUserId({ request, locals });
  if ("response" in authResult) return authResult.response;
  const userId = authResult.userId;

  try {
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

    if (!config.githubConfig?.token) {
      return jsonResponse({
        data: { error: "GitHub token is missing in config" },
        status: 400,
      });
    }

    // Decrypt the GitHub token before using it
    console.log("[Sync Debug] About to decrypt GitHub token");
    const decryptedToken = getDecryptedGitHubToken(config);
    console.log("[Sync Debug] Token decrypted successfully, length:", decryptedToken.length);
    
    const githubUsername = config.githubConfig?.owner || undefined;
    console.log("[Sync Debug] Creating GitHub client with GITHUB_API_URL:", process.env.GITHUB_API_URL);
    const octokit = createGitHubClient(decryptedToken, userId, githubUsername);
    console.log("[Sync Debug] GitHub client created");

    // Fetch GitHub data in parallel
    console.log("[Sync Debug] Fetching GitHub data...");
    const [basicAndForkedRepos, starredRepos, gitOrgs] = await Promise.all([
      getGithubRepositories({ octokit, config }),
      config.githubConfig?.includeStarred
        ? getGithubStarredRepositories({ octokit, config })
        : Promise.resolve([]),
      getGithubOrganizations({ octokit, config }),
    ]);
    console.log("[Sync Debug] GitHub data fetched:", {
      basicAndForkedRepos: basicAndForkedRepos.length,
      starredRepos: starredRepos.length,
      gitOrgs: gitOrgs.length
    });

    // Merge and de-duplicate by fullName, preferring starred variant when duplicated
    const allGithubRepos = mergeGitReposPreferStarred(basicAndForkedRepos, starredRepos);
    const mirrorableGithubRepos = allGithubRepos.filter(isMirrorableGitHubRepo);

    // Prepare full list of repos and orgs
    const newRepos = mirrorableGithubRepos.map((repo) => ({
      id: uuidv4(),
      userId,
      configId: config.id,
      name: repo.name,
      fullName: repo.fullName,
      normalizedFullName: repo.fullName.toLowerCase(),
      url: repo.url,
      cloneUrl: repo.cloneUrl,
      owner: repo.owner,
      organization: repo.organization ?? null,
      mirroredLocation: repo.mirroredLocation || "",
      destinationOrg: repo.destinationOrg || null,
      isPrivate: repo.isPrivate,
      isForked: repo.isForked,
      forkedFrom: repo.forkedFrom ?? null,
      hasIssues: repo.hasIssues,
      isStarred: repo.isStarred,
      isArchived: repo.isArchived,
      size: repo.size,
      hasLFS: repo.hasLFS,
      hasSubmodules: repo.hasSubmodules,
      language: repo.language ?? null,
      description: repo.description ?? null,
      defaultBranch: repo.defaultBranch,
      visibility: repo.visibility,
      status: repo.status,
      lastMirrored: repo.lastMirrored ?? null,
      errorMessage: repo.errorMessage ?? null,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    }));

    const newOrgs = gitOrgs.map((org) => ({
      id: uuidv4(),
      userId,
      configId: config.id,
      name: org.name,
      normalizedName: org.name.toLowerCase(),
      avatarUrl: org.avatarUrl,
      membershipRole: org.membershipRole,
      isIncluded: false,
      status: org.status,
      repositoryCount: org.repositoryCount,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    let insertedRepos: typeof newRepos = [];
    let insertedOrgs: typeof newOrgs = [];

    // Transaction to insert only new items
    await db.transaction(async (tx) => {
      const [existingRepos, existingOrgs] = await Promise.all([
        tx
          .select({ normalizedFullName: repositories.normalizedFullName })
          .from(repositories)
          .where(eq(repositories.userId, userId)),
        tx
          .select({ normalizedName: organizations.normalizedName })
          .from(organizations)
          .where(eq(organizations.userId, userId)),
      ]);

      const existingRepoNames = new Set(existingRepos.map((r) => r.normalizedFullName));
      const existingOrgNames = new Set(existingOrgs.map((o) => o.normalizedName));

      insertedRepos = newRepos.filter(
        (r) => !existingRepoNames.has(r.normalizedFullName)
      );
      insertedOrgs = newOrgs.filter((o) => !existingOrgNames.has(o.normalizedName));

      // Batch insert repositories to avoid SQLite parameter limit (dynamic by column count)
      const sample = newRepos[0];
      const columnCount = Object.keys(sample ?? {}).length || 1;
      const REPO_BATCH_SIZE = calcBatchSizeForInsert(columnCount);
      if (insertedRepos.length > 0) {
        for (let i = 0; i < insertedRepos.length; i += REPO_BATCH_SIZE) {
          const batch = insertedRepos.slice(i, i + REPO_BATCH_SIZE);
          await tx
            .insert(repositories)
            .values(batch)
            .onConflictDoNothing({ target: [repositories.userId, repositories.normalizedFullName] });
        }
      }

      // Batch insert organizations (they have fewer fields, so we can use larger batches)
      const ORG_BATCH_SIZE = 100;
      if (insertedOrgs.length > 0) {
        for (let i = 0; i < insertedOrgs.length; i += ORG_BATCH_SIZE) {
          const batch = insertedOrgs.slice(i, i + ORG_BATCH_SIZE);
          await tx.insert(organizations).values(batch);
        }
      }
    });

    // Create mirror jobs only for newly inserted items
    const mirrorJobPromises = [
      ...insertedRepos.map((repo) =>
        createMirrorJob({
          userId,
          repositoryId: repo.id,
          repositoryName: repo.name,
          status: "imported",
          message: `Repository ${repo.name} fetched successfully`,
          details: `Repository ${repo.name} was fetched from GitHub`,
        })
      ),
      ...insertedOrgs.map((org) =>
        createMirrorJob({
          userId,
          organizationId: org.id,
          organizationName: org.name,
          status: "imported",
          message: `Organization ${org.name} fetched successfully`,
          details: `Organization ${org.name} was fetched from GitHub`,
        })
      ),
    ];

    await Promise.all(mirrorJobPromises);

    return jsonResponse({
      data: {
        success: true,
        message: "Repositories and organizations synced successfully",
        newRepositories: insertedRepos.length,
        newOrganizations: insertedOrgs.length,
        skippedDisabledRepositories: allGithubRepos.length - mirrorableGithubRepos.length,
      },
    });
  } catch (error) {
    // TEMPORARY: Return detailed error for debugging E2E tests
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error("[Sync] Error during sync:", errorMessage);
    return jsonResponse({
      data: {
        error: "GitHub data sync failed",
        message: errorMessage,
        stack: errorStack,
        timestamp: new Date().toISOString(),
      },
      status: 500,
    });
  }
};
