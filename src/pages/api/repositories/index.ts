import type { APIRoute } from "astro";
import { db, repositories, mirrorJobs } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { isPushDestinationKind } from "@/lib/destination-kinds";

export const DELETE: APIRoute = async (context) => {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const userId = user!.id;
    const body = await context.request.json();
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return new Response(JSON.stringify({ error: "ids must be a non-empty array" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Verify all repos belong to this user before deleting
    const owned = await db
      .select({
        id: repositories.id,
        owner: repositories.owner,
        name: repositories.name,
        sourceProvider: repositories.sourceProvider,
        sourceUrl: repositories.sourceUrl,
        destinationProvider: repositories.destinationProvider,
      })
      .from(repositories)
      .where(and(inArray(repositories.id, ids), eq(repositories.userId, userId)));

    const ownedIds = owned.map((r) => r.id);
    if (ownedIds.length === 0) {
      return new Response(JSON.stringify({ error: "No matching repositories found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    await db.transaction(async (tx) => {
      await tx.delete(mirrorJobs).where(and(inArray(mirrorJobs.repositoryId, ownedIds), eq(mirrorJobs.userId, userId)));
      await tx.delete(repositories).where(and(inArray(repositories.id, ownedIds), eq(repositories.userId, userId)));
    });

    // Rows pushed by the engine leave a bare clone behind; drop it with the row.
    const pushed = owned.filter((row) => isPushDestinationKind(row.destinationProvider));
    if (pushed.length > 0) {
      const { removeCloneForRepository } = await import("@/lib/push-engine/cleanup");
      await Promise.all(
        pushed.map((row) =>
          removeCloneForRepository({ repository: row }).catch((error) =>
            console.warn(`[Repositories] Could not remove the clone for ${row.owner}/${row.name}:`, error)
          )
        )
      );
    }

    return new Response(
      JSON.stringify({ success: true, deleted: ownedIds.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "Bulk delete repositories", 500);
  }
};
