import type { APIContext } from "astro";
import { db, repositories } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import { repoStatusEnum } from "@/types/Repository";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export async function PATCH({ params, request, locals }: APIContext) {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const { id } = params;
    const body = await request.json();
    const { status } = body;

    if (!id) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Repository ID is required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Validate the status
    const validStatuses = repoStatusEnum.options;
    if (!validStatuses.includes(status)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Update the repository status
    const [updatedRepo] = await db
      .update(repositories)
      .set({ 
        status,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(repositories.id, id),
          eq(repositories.userId, userId)
        )
      )
      .returning();

    if (!updatedRepo) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Repository not found or you don't have permission to update it",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        repository: updatedRepo,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error);
  }
}
