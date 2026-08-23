import type { APIRoute } from "astro";
import { db } from "@/lib/db";
import { servers, mirrorPairs } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createSecureErrorResponse, jsonResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { updateMirrorPairSchema } from "@/lib/db/schema";
import type { Server } from "@/lib/db/schema";

/** Token-free summary of a server for embedding in pair responses. */
function summarizeServer(server: Server | undefined) {
  if (!server) return null;
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    url: server.url,
  };
}

function notFoundResponse() {
  return jsonResponse({
    status: 404,
    data: { success: false, message: "Mirror pair not found" },
  });
}

export const GET: APIRoute = async ({ request, locals, params }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const rows = await db
      .select()
      .from(mirrorPairs)
      .where(and(eq(mirrorPairs.id, params.id!), eq(mirrorPairs.userId, userId)))
      .limit(1);

    const pair = rows[0];
    if (!pair) {
      return notFoundResponse();
    }

    const userServers = await db
      .select()
      .from(servers)
      .where(eq(servers.userId, userId));

    const serversById = new Map(userServers.map((s) => [s.id, s]));

    return jsonResponse({
      data: {
        pair: {
          ...pair,
          sourceServer: summarizeServer(serversById.get(pair.sourceServerId)),
          targetServer: summarizeServer(serversById.get(pair.targetServerId)),
        },
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "mirror pair fetch", 500);
  }
};

export const PUT: APIRoute = async ({ request, locals, params }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = await request.json();
    const parsed = updateMirrorPairSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({
        status: 400,
        data: {
          success: false,
          message: `Invalid mirror pair payload: ${parsed.error.message}`,
        },
      });
    }

    const rows = await db
      .select()
      .from(mirrorPairs)
      .where(and(eq(mirrorPairs.id, params.id!), eq(mirrorPairs.userId, userId)))
      .limit(1);

    const existing = rows[0];
    if (!existing) {
      return notFoundResponse();
    }

    // If the pair is being re-pointed at different servers, both must exist
    // and belong to this user.
    if (
      parsed.data.sourceServerId !== undefined ||
      parsed.data.targetServerId !== undefined
    ) {
      const userServers = await db
        .select()
        .from(servers)
        .where(eq(servers.userId, userId));

      const serverIds = new Set(userServers.map((s) => s.id));
      if (
        (parsed.data.sourceServerId !== undefined &&
          !serverIds.has(parsed.data.sourceServerId)) ||
        (parsed.data.targetServerId !== undefined &&
          !serverIds.has(parsed.data.targetServerId))
      ) {
        return jsonResponse({
          status: 400,
          data: {
            success: false,
            message: "Source or target server not found",
          },
        });
      }
    }

    const updateFields: Record<string, any> = {
      ...parsed.data,
      updatedAt: new Date(),
    };

    await db
      .update(mirrorPairs)
      .set(updateFields)
      .where(and(eq(mirrorPairs.id, params.id!), eq(mirrorPairs.userId, userId)));

    return jsonResponse({
      data: {
        success: true,
        message: "Mirror pair updated successfully",
        pair: { ...existing, ...updateFields },
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "mirror pair update", 500);
  }
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const rows = await db
      .select()
      .from(mirrorPairs)
      .where(and(eq(mirrorPairs.id, params.id!), eq(mirrorPairs.userId, userId)))
      .limit(1);

    if (!rows[0]) {
      return notFoundResponse();
    }

    await db
      .delete(mirrorPairs)
      .where(and(eq(mirrorPairs.id, params.id!), eq(mirrorPairs.userId, userId)));

    return jsonResponse({
      data: { success: true, message: "Mirror pair deleted successfully" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "mirror pair delete", 500);
  }
};
