import type { APIRoute } from "astro";
import { insertServerSchema } from "@/lib/db/schema";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { testServerConnection } from "@/lib/server-connection-test";
import { createSecureErrorResponse, jsonResponse } from "@/lib/utils";

const connectionTestSchema = insertServerSchema.pick({
  type: true,
  url: true,
  username: true,
  token: true,
});

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const parsed = connectionTestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonResponse({
        status: 400,
        data: {
          success: false,
          message: `Invalid connection payload: ${parsed.error.message}`,
        },
      });
    }

    if (parsed.data.type !== "git" && !parsed.data.token.trim()) {
      return jsonResponse({
        status: 400,
        data: { success: false, message: "A personal access token is required" },
      });
    }

    const result = await testServerConnection(parsed.data, parsed.data.token);
    return jsonResponse({ data: result });
  } catch (error) {
    return createSecureErrorResponse(error, "server connection test", 500);
  }
};
