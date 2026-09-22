import type { APIRoute } from "astro";
import { db, configs, organizations } from "@/lib/db";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { listSources } from "@/lib/sources";
import {
  partitionOrganizationRepositories,
  runOrganizationSync,
  selectOrganizationRepositoryRows,
} from "@/lib/organization-sync";
import { resolveOrganizationSkipForks } from "@/lib/utils/mirror-overrides";
import { repoStatusEnum } from "@/types/Repository";
import { type MembershipRole } from "@/types/organizations";
import type { SyncOrgRequest, SyncOrgResponse } from "@/types/sync";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

function refusal(message: string, status: number) {
  // `message` is echoed as well as `error`: the browser client turns a
  // non-2xx body into "HTTP <status>: <message>", so the toast reads as a
  // sentence instead of a dump of the JSON body.
  return new Response(JSON.stringify({ success: false, error: message, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body: SyncOrgRequest = await request.json();
    const { orgId } = body;

    if (!orgId || typeof orgId !== "string") {
      return refusal("orgId is required.", 400);
    }

    // Fetch config: prefer active and most-recently-updated to avoid picking
    // a stale inactive stub when multiple rows exist (see issue #271).
    const configResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    const config = configResult[0];

    // Syncing only touches the destination, and a public-only source has no
    // token at all, so only the destination token is required here.
    if (!config || !config.giteaConfig?.token) {
      return refusal("Config missing for the user or destination token.", 400);
    }

    const [organization] = await db
      .select()
      .from(organizations)
      .where(and(eq(organizations.userId, userId), eq(organizations.id, orgId)))
      .limit(1);

    if (!organization) {
      return refusal("No organization found for the given ID.", 404);
    }

    if (organization.status === "ignored") {
      return refusal(
        `Organization ${organization.name} is ignored. Include it again before syncing.`,
        409
      );
    }

    if (organization.status === "mirroring") {
      return refusal(`Organization ${organization.name} is already being processed.`, 409);
    }

    // The counts are a snapshot of the rows as they stand now. Repositories
    // the re-discovery pass imports are mirrored by the same run, so the run
    // can do a little more than the response promises, never less.
    const sources = await listSources(userId);
    const rows = await selectOrganizationRepositoryRows({ userId, organization, sources });
    const skipForks = resolveOrganizationSkipForks({
      orgOverrides: organization.mirrorOverrides,
      config,
    });
    const plan = partitionOrganizationRepositories(rows, { skipForks });

    // Claim the organization before answering. The response already reports
    // it as mirroring, and the background run starts a tick later, so a
    // second request must not be able to slip through the gap. A claim that
    // matches no row means another request took it in the meantime.
    const claimed = await db
      .update(organizations)
      .set({ status: repoStatusEnum.parse("mirroring"), updatedAt: new Date() })
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.userId, userId),
          notInArray(organizations.status, ["mirroring", "ignored"])
        )
      )
      .returning({ id: organizations.id });

    if (claimed.length === 0) {
      return refusal(`Organization ${organization.name} is already being processed.`, 409);
    }

    // Fire the sync without blocking the response, the way mirror-org does.
    setTimeout(() => {
      runOrganizationSync({ config, userId, organization }).catch((error) => {
        console.error(`Organization sync for ${organization.name} ended unexpectedly:`, error);
      });
    }, 0);

    const responsePayload: SyncOrgResponse = {
      success: true,
      message: "Sync job started.",
      organization: {
        ...organization,
        // The claim above already wrote this, so the card can show the
        // spinner without waiting for the next fetch.
        status: "mirroring",
        membershipRole: organization.membershipRole as MembershipRole,
        lastMirrored: organization.lastMirrored ?? undefined,
        errorMessage: organization.errorMessage ?? undefined,
        // The row keeps these null when they were never counted; the shared
        // Organization type has them optional.
        publicRepositoryCount: organization.publicRepositoryCount ?? undefined,
        privateRepositoryCount: organization.privateRepositoryCount ?? undefined,
        forkRepositoryCount: organization.forkRepositoryCount ?? undefined,
      },
      queued: {
        mirror: plan.toMirror.length,
        sync: plan.toSync.length,
        skipped: plan.skipped.length,
      },
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "organization sync", 500);
  }
};
