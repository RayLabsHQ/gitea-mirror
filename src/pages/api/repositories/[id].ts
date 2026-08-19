import type { APIRoute } from "astro";
import { db, repositories } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { mirrorOverridesSchema } from "@/lib/db/schema";
import { normalizeMirrorOverrides } from "@/lib/utils/mirror-overrides";

/**
 * Partial update. Each field is optional and only written when present in the
 * body, so updating mirror overrides does not clobber destinationOrg (and vice
 * versa).
 */
const patchBodySchema = z.object({
  destinationOrg: z.string().nullable().optional(),
  mirrorOverrides: mirrorOverridesSchema.nullable().optional(),
});

export const PATCH: APIRoute = async (context) => {
  try {
    // Check authentication
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const userId = user!.id;

    const repoId = context.params.id;
    if (!repoId) {
      return new Response(JSON.stringify({ error: "Repository ID is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsed = patchBodySchema.safeParse(await context.request.json());
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid request body",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = parsed.data;

    // Validate that the repository belongs to the user
    const [existingRepo] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.userId, userId)))
      .limit(1);

    if (!existingRepo) {
      return new Response(JSON.stringify({ error: "Repository not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if ("destinationOrg" in body) {
      updates.destinationOrg = body.destinationOrg || null;
    }

    if ("mirrorOverrides" in body) {
      // normalize drops null-valued flags so "no overrides" is stored as NULL
      // rather than an empty object.
      updates.mirrorOverrides = normalizeMirrorOverrides(body.mirrorOverrides);
    }

    await db
      .update(repositories)
      .set(updates)
      .where(eq(repositories.id, repoId));

    const [updated] = await db
      .select({
        destinationOrg: repositories.destinationOrg,
        mirrorOverrides: repositories.mirrorOverrides,
      })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Repository updated successfully",
        destinationOrg: updated?.destinationOrg ?? null,
        mirrorOverrides: updated?.mirrorOverrides ?? null,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "Update repository", 500);
  }
};
