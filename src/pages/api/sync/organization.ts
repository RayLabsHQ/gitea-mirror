import type { APIRoute } from "astro";
import { configs, db, organizations, repositories } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import type {
  AddOrganizationApiRequest,
  AddOrganizationApiResponse,
} from "@/types/organizations";
import type { RepoStatus } from "@/types/Repository";
import { v4 as uuidv4 } from "uuid";
import { isValidSourceOrgName } from "@/lib/source-providers";
import { normalizeGitRepoToInsert, calcBatchSizeForInsert } from "@/lib/repo-utils";
import { resolveOrganizationSkipForks } from "@/lib/utils/mirror-overrides";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: AddOrganizationApiRequest = await request.json();
    const { role, org, force = false } = body;
    // Optional body field: which connected source to import from; defaults to the primary source.
    const sourceId = (body as AddOrganizationApiRequest & { sourceId?: string }).sourceId?.trim() || undefined;

    if (!org || !role) {
      return jsonResponse({
        data: { success: false, error: "Missing org or role" },
        status: 400,
      });
    }

    const trimmedOrg = org.trim();
    const normalizedOrg = trimmedOrg.toLowerCase();

    if (!isValidSourceOrgName(trimmedOrg)) {
      return jsonResponse({
        data: {
          success: false,
          error:
            "Organization names cannot contain '/'. Add the top level group; nested groups flatten onto it.",
        },
        status: 400,
      });
    }

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

    if (!config.githubConfig?.token) {
      return jsonResponse({
        data: { error: "Source token not configured" },
        status: 401,
      });
    }

    const { listSources } = await import("@/lib/sources");
    const { createSourceProviderFromSource } = await import("@/lib/source-providers");
    const userSources = await listSources(userId);
    const source = sourceId
      ? userSources.find((s) => s.id === sourceId)
      : userSources[0];

    if (sourceId && !source) {
      return jsonResponse({
        data: {
          success: false,
          error: `No source with id ${sourceId} belongs to this user`,
        },
        status: 400,
      });
    }

    if (!source) {
      return jsonResponse({
        data: {
          success: false,
          error: "No source is configured for this user",
        },
        status: 400,
      });
    }

    const sourceProvider = createSourceProviderFromSource(source, { userId });

    // Fetch org metadata
    const orgData = await sourceProvider.getOrganization(trimmedOrg);
    if (!orgData) {
      return jsonResponse({
        data: {
          success: false,
          error: `Organization ${trimmedOrg} was not found on the configured source`,
        },
        status: 404,
      });
    }

    // Fetch every repository the token can see in the organization
    const orgRepos = await sourceProvider.listOrganizationRepositories(trimmedOrg);

    // Both existing-org branches above returned, so this organization is new
    // and has no overrides: the fork policy resolves from the global switch.
    const skipOrgForks = resolveOrganizationSkipForks({ orgOverrides: null, config });
    const mirrorableRepos = orgRepos.filter(
      (repo) => repo.isDisabled !== true && !(skipOrgForks && repo.isForked)
    );

    // Insert repositories. The normalizer stamps the source provider and URL.
    const repoRecords = mirrorableRepos.map((repo) =>
      normalizeGitRepoToInsert(
        { ...repo, organization: repo.organization ?? orgData.name },
        { userId, configId, sourceId: source.id }
      )
    );

    // Batch insert repositories to avoid SQLite parameter limit
    // Compute batch size based on column count
    const sample = repoRecords[0];
    const columnCount = Object.keys(sample ?? {}).length || 1;
    const BATCH_SIZE = calcBatchSizeForInsert(columnCount);
    for (let i = 0; i < repoRecords.length; i += BATCH_SIZE) {
      const batch = repoRecords.slice(i, i + BATCH_SIZE);
      await db
        .insert(repositories)
        .values(batch)
        .onConflictDoNothing({
          target: [repositories.userId, repositories.sourceId, repositories.normalizedFullName],
        });
    }

    // Insert organization metadata
    const organizationRecord = {
      id: uuidv4(),
      userId,
      configId,
      name: orgData.name,
      normalizedName: normalizedOrg,
      avatarUrl: orgData.avatarUrl,
      membershipRole: role,
      isIncluded: false,
      status: "imported" as RepoStatus,
      repositoryCount: orgRepos.length,
      createdAt: orgData.createdAt,
      updatedAt: orgData.updatedAt,
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
