import type { APIRoute } from "astro";
import { db } from "@/lib/db";
import { servers, mirrorPairs } from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import { createSecureErrorResponse, jsonResponse } from "@/lib/utils";
import { encrypt, decrypt } from "@/lib/utils/encryption";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { updateServerSchema } from "@/lib/db/schema";
import type { Server } from "@/lib/db/schema";

function notFoundResponse() {
  return jsonResponse({
    status: 404,
    data: { success: false, message: "Server not found" },
  });
}

export const GET: APIRoute = async ({ request, locals, params }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const rows = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, params.id!), eq(servers.userId, userId)))
      .limit(1);

    const server = rows[0];
    if (!server) {
      return notFoundResponse();
    }

    let responseServer: Server = server;
    try {
      responseServer = {
        ...server,
        token: server.token ? decrypt(server.token) : server.token,
      };
    } catch (error) {
      console.error("Failed to decrypt server token:", error);
    }

    return jsonResponse({ data: { server: responseServer } });
  } catch (error) {
    return createSecureErrorResponse(error, "server fetch", 500);
  }
};

export const PUT: APIRoute = async ({ request, locals, params }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = await request.json();
    const parsed = updateServerSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({
        status: 400,
        data: {
          success: false,
          message: `Invalid server payload: ${parsed.error.message}`,
        },
      });
    }

    const rows = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, params.id!), eq(servers.userId, userId)))
      .limit(1);

    const existing = rows[0];
    if (!existing) {
      return notFoundResponse();
    }

    const updateFields: Record<string, any> = {
      ...parsed.data,
      updatedAt: new Date(),
    };

    // An absent or empty token means "keep the existing one"; otherwise store
    // the new token encrypted.
    if (parsed.data.token === undefined || parsed.data.token === "") {
      delete updateFields.token;
    } else {
      updateFields.token = encrypt(parsed.data.token);
    }

    await db
      .update(servers)
      .set(updateFields)
      .where(and(eq(servers.id, params.id!), eq(servers.userId, userId)));

    const updatedToken =
      parsed.data.token !== undefined && parsed.data.token !== ""
        ? parsed.data.token
        : existing.token
          ? decrypt(existing.token)
          : existing.token;

    return jsonResponse({
      data: {
        success: true,
        message: "Server updated successfully",
        server: { ...existing, ...updateFields, token: updatedToken },
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "server update", 500);
  }
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const rows = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, params.id!), eq(servers.userId, userId)))
      .limit(1);

    if (!rows[0]) {
      return notFoundResponse();
    }

    // Remove mirror pairs referencing this server first — the FK constraint
    // on mirror_pairs.source_server_id / target_server_id would otherwise
    // reject the server delete.
    await db
      .delete(mirrorPairs)
      .where(
        and(
          eq(mirrorPairs.userId, userId),
          or(
            eq(mirrorPairs.sourceServerId, params.id!),
            eq(mirrorPairs.targetServerId, params.id!)
          )
        )
      );

    await db
      .delete(servers)
      .where(and(eq(servers.id, params.id!), eq(servers.userId, userId)));

    return jsonResponse({
      data: { success: true, message: "Server deleted successfully" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "server delete", 500);
  }
};
