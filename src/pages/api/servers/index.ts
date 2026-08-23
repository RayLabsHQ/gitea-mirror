import type { APIRoute } from "astro";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createSecureErrorResponse, jsonResponse } from "@/lib/utils";
import { encrypt, decrypt } from "@/lib/utils/encryption";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { insertServerSchema } from "@/lib/db/schema";
import type { Server } from "@/lib/db/schema";

function decryptServerToken(server: Server): Server {
  try {
    return { ...server, token: server.token ? decrypt(server.token) : server.token };
  } catch (error) {
    console.error("Failed to decrypt server token:", error);
    return server;
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const rows = await db
      .select()
      .from(servers)
      .where(eq(servers.userId, userId));

    return jsonResponse({
      data: { servers: rows.map(decryptServerToken) },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "servers list", 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = await request.json();
    const parsed = insertServerSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({
        status: 400,
        data: {
          success: false,
          message: `Invalid server payload: ${parsed.error.message}`,
        },
      });
    }

    const serverId = uuidv4();
    const newServer = {
      id: serverId,
      userId,
      ...parsed.data,
      token: parsed.data.token ? encrypt(parsed.data.token) : "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(servers).values(newServer);

    // Return the server with the plaintext token, matching the GET convention
    // of returning decrypted tokens to the UI.
    return jsonResponse({
      status: 201,
      data: {
        success: true,
        message: "Server created successfully",
        server: { ...newServer, token: parsed.data.token },
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "server create", 500);
  }
};
