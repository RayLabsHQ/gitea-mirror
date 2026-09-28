import type { APIRoute } from "astro";
import {
  SOURCE_PROVIDER_LABELS,
  isSourceProviderKind,
  isValidSourceUrl,
} from "@/lib/source-providers/kinds";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { blockedOutboundUrlReason } from "@/lib/utils/outbound-url";
import { createSecureErrorResponse } from "@/lib/utils";
import { createSource } from "@/lib/sources";
import { encodeGitHubAppCredentials } from "@/lib/github-app-credentials";
import {
  isDuplicateSourceError,
  loadSourceApiItems,
  toSourceApiItem,
} from "@/lib/sources-api";

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const sources = await loadSourceApiItems(userId);

    return new Response(JSON.stringify({ success: true, sources }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "sources fetch", 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = (await request.json()) as {
      name?: unknown;
      provider?: unknown;
      url?: unknown;
      username?: unknown;
      token?: unknown;
      authType?: unknown;
      appId?: unknown;
      installationId?: unknown;
      privateKey?: unknown;
      enabled?: unknown;
    };

    if (!isSourceProviderKind(body.provider)) {
      return new Response(
        JSON.stringify({ success: false, message: "Unknown source provider." }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    const provider = body.provider;
    if (body.authType !== undefined && body.authType !== "app" && body.authType !== "pat") {
      return new Response(JSON.stringify({ success: false, message: "Unknown authentication method." }), { status: 400 });
    }
    if (body.authType === "app" && provider !== "github") {
      return new Response(JSON.stringify({ success: false, message: "GitHub App authentication requires a GitHub source." }), { status: 400 });
    }
    let token: string | undefined;
    try {
      token = body.authType === "app"
        ? encodeGitHubAppCredentials({ appId: String(body.appId ?? ""), installationId: String(body.installationId ?? ""), privateKey: String(body.privateKey ?? "") })
        : typeof body.token === "string" ? body.token : undefined;
    } catch (error) {
      return new Response(JSON.stringify({ success: false, message: (error as Error).message }), { status: 400 });
    }

    // All sources may point at their own instance; validate explicit URLs.
    {
      const rawSourceUrl = typeof body.url === "string" ? body.url.trim() : "";
      if (rawSourceUrl && !isValidSourceUrl(rawSourceUrl)) {
        return new Response(
          JSON.stringify({
            success: false,
            message: `${SOURCE_PROVIDER_LABELS[provider]} URL must be a valid http or https URL.`,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      const blocked = rawSourceUrl ? await blockedOutboundUrlReason(rawSourceUrl) : null;
      if (blocked) {
        return new Response(
          JSON.stringify({ success: false, message: blocked }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    let created: Awaited<ReturnType<typeof createSource>>;
    try {
      created = await createSource(userId, {
        name: typeof body.name === "string" ? body.name : undefined,
        provider,
        url: typeof body.url === "string" ? body.url : undefined,
        username: typeof body.username === "string" ? body.username : undefined,
        token,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      });
    } catch (error) {
      if (isDuplicateSourceError(error)) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "This source is already connected.";
        return new Response(JSON.stringify({ success: false, message }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw error;
    }

    // createSource syncs the legacy config's connection fields itself.
    const source = await toSourceApiItem(created, 0);

    return new Response(JSON.stringify({ success: true, source }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "source create", 500);
  }
};
