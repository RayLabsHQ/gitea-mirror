import type { APIRoute } from "astro";
import { db, organizations, repositories } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { mirrorOverridesSchema } from "@/lib/db/schema";
import { normalizeMirrorOverrides } from "@/lib/utils/mirror-overrides";

/**
 * Partial update. Each field is optional and only written when present in the
 * body, so updating mirror overrides does not clobber destinationOrg.
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

    const orgId = context.params.id;
    if (!orgId) {
      return new Response(JSON.stringify({ error: "Organization ID is required" }), {
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

    // Validate that the organization belongs to the user
    const [existingOrg] = await db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.userId, userId)))
      .limit(1);

    if (!existingOrg) {
      return new Response(JSON.stringify({ error: "Organization not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if ("destinationOrg" in body) {
      updates.destinationOrg = body.destinationOrg || null;
    }

    if ("mirrorOverrides" in body) {
      updates.mirrorOverrides = normalizeMirrorOverrides(body.mirrorOverrides);
    }

    await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, orgId));

    const [updated] = await db
      .select({
        destinationOrg: organizations.destinationOrg,
        mirrorOverrides: organizations.mirrorOverrides,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Organization updated successfully",
        destinationOrg: updated?.destinationOrg ?? null,
        mirrorOverrides: updated?.mirrorOverrides ?? null,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "Update organization", 500);
  }
};

export const DELETE: APIRoute = async (context) => {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const userId = user!.id;
    const orgId = context.params.id;

    if (!orgId) {
      return new Response(
        JSON.stringify({ error: "Organization ID is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const [existingOrg] = await db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.userId, userId)))
      .limit(1);

    if (!existingOrg) {
      return new Response(
        JSON.stringify({ error: "Organization not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    await db.delete(repositories).where(
      and(
        eq(repositories.userId, userId),
        eq(repositories.organization, existingOrg.name)
      )
    );

    await db
      .delete(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.userId, userId)));

    return new Response(
      JSON.stringify({ success: true }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "Delete organization", 500);
  }
};
