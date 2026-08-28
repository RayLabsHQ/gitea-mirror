import type { APIRoute } from "astro";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createSecureErrorResponse, jsonResponse } from "@/lib/utils";
import { decrypt } from "@/lib/utils/encryption";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { testServerConnection } from "@/lib/server-connection-test";

export const POST: APIRoute = async ({ request, locals, params }) => {
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
      return jsonResponse({
        status: 404,
        data: { success: false, message: "Server not found" },
      });
    }

    let token = "";
    try {
      token = server.token ? decrypt(server.token) : "";
    } catch (error) {
      console.error("Failed to decrypt server token:", error);
    }

    const result = await testServerConnection(server, token);

    // The test outcome itself is reported in the body, not the HTTP status.
    return jsonResponse({ data: result });
  } catch (error) {
    return createSecureErrorResponse(error, "server connection test", 500);
  }
};
