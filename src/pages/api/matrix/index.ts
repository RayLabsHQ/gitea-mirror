import type { APIRoute } from "astro";
import { db } from "@/lib/db";
import { servers, mirrorPairs } from "@/lib/db/schema";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createSecureErrorResponse, jsonResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { insertMirrorPairSchema } from "@/lib/db/schema";
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

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const pairs = await db
      .select()
      .from(mirrorPairs)
      .where(eq(mirrorPairs.userId, userId));

    const userServers = await db
      .select()
      .from(servers)
      .where(eq(servers.userId, userId));

    const serversById = new Map(userServers.map((s) => [s.id, s]));

    return jsonResponse({
      data: {
        pairs: pairs.map((pair) => ({
          ...pair,
          sourceServer: summarizeServer(serversById.get(pair.sourceServerId)),
          targetServer: summarizeServer(serversById.get(pair.targetServerId)),
        })),
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "matrix list", 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = await request.json();
    const parsed = insertMirrorPairSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({
        status: 400,
        data: {
          success: false,
          message: `Invalid mirror pair payload: ${parsed.error.message}`,
        },
      });
    }

    const userServers = await db
      .select()
      .from(servers)
      .where(eq(servers.userId, userId));

    const serversById = new Map(userServers.map((s) => [s.id, s]));
    if (
      !serversById.has(parsed.data.sourceServerId) ||
      !serversById.has(parsed.data.targetServerId)
    ) {
      return jsonResponse({
        status: 400,
        data: {
          success: false,
          message: "Source or target server not found",
        },
      });
    }

    const pairId = uuidv4();
    const newPair = {
      id: pairId,
      userId,
      ...parsed.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(mirrorPairs).values(newPair);

    return jsonResponse({
      status: 201,
      data: {
        success: true,
        message: "Mirror pair created successfully",
        pair: {
          ...newPair,
          sourceServer: summarizeServer(serversById.get(newPair.sourceServerId)),
          targetServer: summarizeServer(serversById.get(newPair.targetServerId)),
        },
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "mirror pair create", 500);
  }
};
