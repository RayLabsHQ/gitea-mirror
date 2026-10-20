import type { APIRoute } from "astro";
import { and, eq, sql } from "drizzle-orm";
import { db, repositories } from "@/lib/db";
import {
  SOURCE_PROVIDER_LABELS,
  isSourceProviderKind,
  isValidSourceUrl,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";
import {
  computeConfigLocks,
  describeSourceIdentity,
  evaluateConfigChange,
  sourceIdentity,
} from "@/lib/config-locks";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { blockedOutboundUrlReason } from "@/lib/utils/outbound-url";
import { createSecureErrorResponse } from "@/lib/utils";
import {
  deleteSource,
  listSources,
  updateSource,
} from "@/lib/sources";
import { toSourceApiItem } from "@/lib/sources-api";
import {
  encodeGitHubAppCredentials,
  isGitHubAppCredential,
  parseGitHubAppCredentials,
} from "@/lib/github-app-credentials";
import { decryptSourceToken } from "@/lib/sources";

/** Repositories imported from this source; they are what locks it. */
async function countRepositoriesForSource(
  userId: string,
  sourceId: string
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(and(eq(repositories.userId, userId), eq(repositories.sourceId, sourceId)));
  return Number(row?.count ?? 0);
}

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ success: false, message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const sourceId = params.id;
    if (!sourceId) {
      return jsonError("Source ID is required.", 400);
    }

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
      confirmSourceChange?: unknown;
    };

    const sources = await listSources(userId);
    const existing = sources.find((source) => source.id === sourceId);
    if (!existing) {
      return jsonError("Source not found.", 404);
    }

    if (body.provider !== undefined && !isSourceProviderKind(body.provider)) {
      return jsonError("Unknown source provider.", 400);
    }
    const provider: SourceProviderKind = isSourceProviderKind(body.provider)
      ? body.provider
      : existing.provider;
    if (body.authType !== undefined && body.authType !== "app" && body.authType !== "pat") return jsonError("Unknown authentication method.", 400);
    if (body.authType === "app" && provider !== "github") return jsonError("GitHub App authentication requires a GitHub source.", 400);
    let token = typeof body.token === "string" ? body.token : undefined;
    if (body.authType === "app") {
      const prior = existing.provider === "github" ? parseGitHubAppCredentials(decryptSourceToken(existing.token)) : null;
      try {
        token = encodeGitHubAppCredentials({
          appId: String(body.appId ?? ""),
          installationId: String(body.installationId ?? ""),
          privateKey: typeof body.privateKey === "string" && body.privateKey.trim() ? body.privateKey : prior?.privateKey ?? "",
        });
      } catch (error) {
        return jsonError((error as Error).message, 400);
      }
    } else if (isGitHubAppCredential(token)) {
      return jsonError("Use the GitHub App fields to enter App credentials.", 400);
    }
    // The stored App credential holds the private key. Moving the source to
    // another provider or to token auth without a new token would keep it,
    // return it from the API and send it to the new host as the token.
    if (
      body.authType !== "app" &&
      (provider !== "github" || body.authType === "pat") &&
      !token?.trim() &&
      isGitHubAppCredential(decryptSourceToken(existing.token))
    ) {
      return jsonError(
        `Enter a ${SOURCE_PROVIDER_LABELS[provider]} token to stop using the GitHub App credentials on this source.`,
        400
      );
    }

    // All sources may point at their own instance; validate explicit URLs.
    if (
      typeof body.url === "string" &&
      body.url.trim() &&
      !isValidSourceUrl(body.url)
    ) {
      return jsonError(
        `${SOURCE_PROVIDER_LABELS[provider]} URL must be a valid http or https URL.`,
        400
      );
    }
    if (typeof body.url === "string" && body.url.trim()) {
      const blocked = await blockedOutboundUrlReason(body.url);
      if (blocked) return jsonError(blocked, 400);
    }

    const repositoryCount = await countRepositoriesForSource(userId, sourceId);

    // A source repositories were imported from only switches host with an
    // explicit confirmation (the same rule as the configuration card).
    const verdict = evaluateConfigChange({
      locks: computeConfigLocks({ repositoryCount, mirroredCount: 0 }),
      existingSource: { provider: existing.provider, url: existing.url },
      incomingSource: {
        provider,
        url: typeof body.url === "string" ? body.url : existing.url,
      },
      existingDestinationUrl: "",
      incomingDestinationUrl: "",
      confirmSourceChange: body.confirmSourceChange === true,
    });
    if (!verdict.ok) {
      return jsonError(verdict.message, 409, { lock: verdict.lock });
    }

    const updated = await updateSource(userId, sourceId, {
      name: typeof body.name === "string" ? body.name : undefined,
      provider: body.provider === undefined ? undefined : provider,
      url: typeof body.url === "string" ? body.url : undefined,
      username: typeof body.username === "string" ? body.username : undefined,
      // An empty token keeps the stored one (the service preserves it).
      token,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });

    // updateSource syncs the legacy config's connection fields itself.
    const source = await toSourceApiItem(updated, repositoryCount);

    return new Response(JSON.stringify({ success: true, source }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "source update", 500);
  }
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const sourceId = params.id;
    if (!sourceId) {
      return jsonError("Source ID is required.", 400);
    }

    const sources = await listSources(userId);
    const existing = sources.find((source) => source.id === sourceId);
    if (!existing) {
      return jsonError("Source not found.", 404);
    }

    const repositoryCount = await countRepositoriesForSource(userId, sourceId);

    // The confirmation flag may arrive as a query parameter or in the body.
    let confirmRemoveSource = ["true", "1"].includes(
      new URL(request.url).searchParams.get("confirmRemoveSource") ?? ""
    );
    const rawBody = await request.text();
    if (rawBody.trim()) {
      try {
        const body = JSON.parse(rawBody) as { confirmRemoveSource?: unknown };
        confirmRemoveSource = confirmRemoveSource || body.confirmRemoveSource === true;
      } catch {
        // Not JSON: the flag was not sent in the body.
      }
    }

    if (repositoryCount > 0 && !confirmRemoveSource) {
      const label = describeSourceIdentity(
        sourceIdentity({ provider: existing.provider, url: existing.url })
      );
      return jsonError(
        `${repositoryCount} ${
          repositoryCount === 1 ? "repository was" : "repositories were"
        } imported from ${label}; confirm the removal to disconnect it. ` +
          `Existing mirrors keep syncing on the destination with their stored credentials.`,
        409,
        { lock: "source" }
      );
    }

    await deleteSource(userId, sourceId);

    // deleteSource syncs the legacy config's connection fields itself;
    // repositories keep their sourceId on purpose (dangling by design).
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "source delete", 500);
  }
};
