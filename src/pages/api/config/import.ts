import type { APIRoute } from "astro";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { createSecureErrorResponse } from "@/lib/utils";
import { SettingsImportError, importSettings } from "@/lib/settings-import";

/** A file listing every repository of a large instance stays well under this. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * POST /api/config/import (#587): reads back a file from GET
 * /api/config/export. Body: `{ file, apply?, confirmDestinationChange? }`,
 * where `file` is the parsed file (or its text). Without `apply: true` it only
 * answers what would change; with it, it makes the changes. A file that moves
 * a locked destination answers 409 until `confirmDestinationChange` is set.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      return json({ success: false, message: "The file is too large to import." }, 413);
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return json({ success: false, message: "The file is too large to import." }, 413);
    }

    let body: { file?: unknown; apply?: unknown; confirmDestinationChange?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return json({ success: false, message: "The request is not valid JSON." }, 400);
    }
    if (!body || typeof body !== "object") {
      return json({ success: false, message: "The request needs a file to import." }, 400);
    }

    let file = body.file;
    if (typeof file === "string") {
      try {
        file = JSON.parse(file);
      } catch {
        return json({ success: false, message: "The file is not valid JSON." }, 400);
      }
    }

    const apply = body.apply === true;
    const result = await importSettings(userId, file, {
      apply,
      confirmDestinationChange: body.confirmDestinationChange === true,
    });

    if (apply && !result.applied && result.summary.destinationLock) {
      return json(
        {
          success: false,
          lock: "destination",
          message: result.summary.destinationLock,
          summary: result.summary,
        },
        409
      );
    }
    return json({ success: true, applied: result.applied, summary: result.summary }, 200);
  } catch (error) {
    if (error instanceof SettingsImportError) {
      return json({ success: false, message: error.message, details: error.details }, 400);
    }
    return createSecureErrorResponse(error, "settings import", 500);
  }
};
