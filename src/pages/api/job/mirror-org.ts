import type { APIRoute } from "astro";
import type { MirrorOrgRequest, MirrorOrgResponse } from "@/types/mirror";
import { db, configs, organizations } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { createGitHubClient } from "@/lib/github";
import { mirrorGitHubOrgToGitea } from "@/lib/gitea";
import { repoStatusEnum } from "@/types/Repository";
import { type MembershipRole } from "@/types/organizations";
import { createSecureErrorResponse } from "@/lib/utils";
import { processWithResilience } from "@/lib/utils/concurrency";
import { v4 as uuidv4 } from "uuid";
import { getDecryptedGitHubToken } from "@/lib/utils/config-encryption";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: MirrorOrgRequest = await request.json();
    const { organizationIds } = body;

    if (!organizationIds || !Array.isArray(organizationIds)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "organizationIds are required.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (organizationIds.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "No organization IDs provided.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch config
    const configResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    const config = configResult[0];

    if (!config || !config.githubConfig.token) {
      return new Response(
        JSON.stringify({ error: "Config missing for the user or token." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch organizations
    const orgs = await db
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.userId, userId),
          inArray(organizations.id, organizationIds)
        )
      );

    if (!orgs.length) {
      return new Response(
        JSON.stringify({ error: "No organizations found for the given IDs." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fire async mirroring without blocking response, using parallel processing with resilience
    setTimeout(async () => {
      if (!config.githubConfig.token) {
        throw new Error("GitHub token is missing in config.");
      }

      // Create a single Octokit instance to be reused with rate limit tracking
      const decryptedToken = getDecryptedGitHubToken(config);
      const githubUsername = config.githubConfig?.owner || undefined;
      const octokit = createGitHubClient(decryptedToken, userId, githubUsername);

      // Define the concurrency limit - adjust based on API rate limits
      // Using a lower concurrency for organizations since each org might contain many repos
      const CONCURRENCY_LIMIT = 2;

      // Generate a batch ID to group related organizations
      const batchId = uuidv4();

      // Process organizations in parallel with resilience to container restarts
      await processWithResilience(
        orgs,
        async (org) => {
          // Prepare organization data
          const orgData = {
            ...org,
            status: repoStatusEnum.parse("imported"),
            membershipRole: org.membershipRole as MembershipRole,
            lastMirrored: org.lastMirrored ?? undefined,
            errorMessage: org.errorMessage ?? undefined,
          };

          // Log the start of mirroring
          console.log(`Starting mirror for organization: ${org.name}`);

          // Mirror the organization
          await mirrorGitHubOrgToGitea({
            config,
            octokit,
            organization: orgData,
          });

          return org;
        },
        {
          userId: config.userId || "",
          jobType: "mirror",
          batchId,
          getItemId: (org) => org.id,
          getItemName: (org) => org.name,
          concurrencyLimit: CONCURRENCY_LIMIT,
          maxRetries: 2,
          retryDelay: 3000,
          checkpointInterval: 1, // Checkpoint after each organization
          onProgress: (completed, total, result) => {
            const percentComplete = Math.round((completed / total) * 100);
            console.log(`Organization mirroring progress: ${percentComplete}% (${completed}/${total})`);

            if (result) {
              console.log(`Successfully mirrored organization: ${result.name}`);
            }
          },
          onRetry: (org, error, attempt) => {
            console.log(`Retrying organization ${org.name} (attempt ${attempt}): ${error.message}`);
          }
        }
      );

      console.log("All organization mirroring tasks completed");
    }, 0);

    const responsePayload: MirrorOrgResponse = {
      success: true,
      message: "Mirror job started.",
      organizations: orgs.map((org) => ({
        ...org,
        status: repoStatusEnum.parse(org.status),
        membershipRole: org.membershipRole as MembershipRole,
        lastMirrored: org.lastMirrored ?? undefined,
        errorMessage: org.errorMessage ?? undefined,
      })),
    };

    // Immediate response
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "mirror organization", 500);
  }
};
