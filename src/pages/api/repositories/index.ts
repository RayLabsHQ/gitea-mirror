import type { APIRoute } from "astro";
import { db, repositories, mirrorJobs } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";

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
      .select({ id: repositories.id })
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

    return new Response(
      JSON.stringify({ success: true, deleted: ownedIds.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "Bulk delete repositories", 500);
  }
};
