import type { APIRoute } from "astro";
import { configs, db, organizations, repositories } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import type {
  AddOrganizationApiRequest,
  AddOrganizationApiResponse,
  GitOrg,
} from "@/types/organizations";
import { v4 as uuidv4 } from "uuid";
import {
  SOURCE_PROVIDER_KINDS,
  isSourceProviderKind,
  isValidSourceOrgName,
  normalizeSourceUrl,
} from "@/lib/source-providers/kinds";
import type { SourceRecord } from "@/lib/sources";
import {
  normalizeGitRepoToInsert,
  calcBatchSizeForInsert,
  repositoryIdentityKeys,
  selectNewRepositoriesByIdentity,
} from "@/lib/repo-utils";
import { resolveOrganizationSkipForks } from "@/lib/utils/mirror-overrides";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: AddOrganizationApiRequest = await request.json();
    const { role, org, force = false } = body;
    if (body.sourceId !== undefined && typeof body.sourceId !== "string") {
      return jsonResponse({
        data: { success: false, error: "sourceId must be a string" },
        status: 400,
      });
    }
    const sourceId = body.sourceId?.trim() || undefined;

    // Public mode sends a provider (and optionally an instance URL) instead
    // of a sourceId. Unknown providers are rejected up front; falling through
    // to the primary source would silently import from the wrong host.
    if (body.provider !== undefined && !isSourceProviderKind(body.provider)) {
      return jsonResponse({
        data: {
          success: false,
          error: `Unsupported provider. Supported providers: ${SOURCE_PROVIDER_KINDS.join(", ")}.`,
        },
        status: 400,
      });
    }

    if (!org || !role) {
      return jsonResponse({
        data: { success: false, error: "Missing org or role" },
        status: 400,
      });
    }

    const trimmedOrg = org.trim();
    const normalizedOrg = trimmedOrg.toLowerCase();

    // A sourceId pin is ownership-checked before any branch that could store
    // it, so neither the force re-pin nor a full import skips validation.
    if (sourceId) {
      const { listSources } = await import("@/lib/sources");
      const owned = (await listSources(userId)).some((s) => s.id === sourceId);
      if (!owned) {
        return jsonResponse({
          data: {
            success: false,
            error: `No source with id ${sourceId} belongs to this user`,
          },
          status: 400,
        });
      }
    }

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

    const { listSources, createSource, DuplicateSourceError } = await import("@/lib/sources");
    const { createSourceProviderFromSource } = await import("@/lib/source-providers");

    // Resolve the source to import from: an explicit pin, the provider named
    // in the request (find-or-create a tokenless row so public organizations
    // import with nothing configured), or the primary source as before. The
    // force branch below also re-pins from this resolution, so it runs before
    // that branch; it needs no config.
    let userSources = await listSources(userId);
    let source: SourceRecord | undefined;
    if (sourceId) {
      source = userSources.find((s) => s.id === sourceId);
    } else if (body.provider && isSourceProviderKind(body.provider)) {
      const provider = body.provider;
      const url = normalizeSourceUrl(body.sourceUrl, provider);
      const findTokenless = (rows: SourceRecord[]) =>
        rows.find((s) => s.provider === provider && s.url === url && !s.username);
      source = findTokenless(userSources);
      if (!source) {
        try {
          source = await createSource(userId, {
            provider,
            url,
            username: "",
            token: "",
          });
        } catch (error) {
          if (!(error instanceof DuplicateSourceError)) throw error;
          // A concurrent request created the same tokenless row; reuse it.
          userSources = await listSources(userId);
          source = findTokenless(userSources);
        }
      }
    } else {
      // May be tokenless: providers then see public listings only.
      source = userSources[0];
    }

    if (sourceId && !source) {
      return jsonResponse({
        data: {
          success: false,
          error: `No source with id ${sourceId} belongs to this user`,
        },
        status: 400,
      });
    }

    if (existingOrg && force) {
      const [updatedOrg] = await db
        .update(organizations)
        .set({
          membershipRole: role,
          normalizedName: normalizedOrg,
          // Only a request that named a source (an explicit pin, or public
          // mode's provider) re-pins; a bare force re-add must leave the
          // organization's own pin, including "every source", alone.
          ...(source && (sourceId || body.provider) ? { sourceId: source.id } : {}),
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

    // Fetch org metadata. Tokenless sources can be rate limited (403/429) on
    // this call while the repository listing below still works, so a throw
    // falls back to a minimal record; only a null result (not found) aborts.
    let orgMetadata: GitOrg | null = null;
    let metadataFetched = true;
    try {
      orgMetadata = await sourceProvider.getOrganization(trimmedOrg);
    } catch {
      metadataFetched = false;
    }
    if (!orgMetadata && metadataFetched) {
      return jsonResponse({
        data: {
          success: false,
          error: `Organization ${trimmedOrg} was not found on the configured source`,
        },
        status: 404,
      });
    }

    // Fetch every repository the source can see in the organization
    const orgRepos = await sourceProvider.listOrganizationRepositories(trimmedOrg);

    const orgData: GitOrg = orgMetadata ?? {
      name: trimmedOrg,
      avatarUrl: "",
      membershipRole: role,
      isIncluded: false,
      status: "imported",
      repositoryCount: orgRepos.length,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Both existing-org branches above returned, so this organization is new
    // and has no overrides: the fork policy resolves from the global switch.
    const skipOrgForks = resolveOrganizationSkipForks({ orgOverrides: null, config });
    const mirrorableRepos = orgRepos.filter(
      (repo) => repo.isDisabled !== true && !(skipOrgForks && repo.isForked)
    );

    // Insert repositories. The normalizer stamps the source provider and URL.
    // Repositories the user already tracks on this host under another source
    // (the personal source, say) are not inserted a second time: two rows for
    // one upstream repository would both mirror to the same destination.
    const existingRepos = await db
      .select({
        normalizedFullName: repositories.normalizedFullName,
        sourceProvider: repositories.sourceProvider,
        sourceUrl: repositories.sourceUrl,
      })
      .from(repositories)
      .where(eq(repositories.userId, userId));
    const { fresh: repoRecords, alreadyTracked } = selectNewRepositoriesByIdentity(
      mirrorableRepos.map((repo) =>
        normalizeGitRepoToInsert(
          { ...repo, organization: repo.organization ?? orgData.name },
          { userId, configId, sourceId: source.id }
        )
      ),
      repositoryIdentityKeys(existingRepos)
    );
    if (alreadyTracked.length > 0) {
      console.log(
        `[Organization import] ${alreadyTracked.length} repositories of ${orgData.name} are already tracked for user ${userId} on this host; not adding them again under source ${source.name}`
      );
    }

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
      // Column is NOT NULL; the rate-limit fallback record carries "".
      avatarUrl: orgData.avatarUrl || "",
      membershipRole: role,
      isIncluded: false,
      sourceId: source.id,
      status: "imported" as const,
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
