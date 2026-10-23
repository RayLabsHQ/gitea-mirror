import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { db, configs, repositories } from "@/lib/db";
import type { Repository } from "@/lib/db/schema";
import type { Config } from "@/types/config";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { getGiteaRepoOwnerAsync } from "@/lib/gitea";
import { decryptConfigTokens } from "@/lib/utils/config-encryption";
import { httpGet } from "@/lib/http-client";

/** Gitea's per-page maximum; the cap below is how far the preview looks. */
const PAGE_SIZE = 100;
const MAX_RELEASES = 300;

type DestinationRelease = {
  tag: string;
  prerelease: boolean | null;
};

/**
 * List the releases the destination already holds for one mirrored repository.
 *
 * The release-rule editor re-runs the draft filters against this list so a user
 * can see which published releases a Save would keep and which the next sync
 * would delete. The owner is taken from `mirroredLocation` when the mirror has
 * already been placed; otherwise it is resolved the way a sync would resolve it.
 *
 * GET /api/repositories/:id/releases
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const repoId = params.id;
    if (!repoId) {
      return jsonResponse({ data: { success: false, error: "Repository ID is required" }, status: 400 });
    }

    const [row] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.userId, userId)))
      .limit(1);
    if (!row) {
      return jsonResponse({ data: { success: false, error: "Repository not found" }, status: 404 });
    }
    const repository = row as Repository;

    const [config] = await db
      .select()
      .from(configs)
      .where(and(eq(configs.userId, userId), eq(configs.isActive, true)))
      .limit(1);
    if (!config) {
      return jsonResponse({ data: { success: false, error: "No active configuration found" }, status: 404 });
    }
    if (!config.giteaConfig?.url || !config.giteaConfig?.token || !config.giteaConfig?.defaultOwner) {
      return jsonResponse({
        data: { success: false, error: "Configure the destination URL, username and token first" },
        status: 400,
      });
    }

    const partial = config as unknown as Partial<Config>;
    const location = (repository.mirroredLocation ?? "").trim();
    const slash = location.indexOf("/");
    let owner = slash > 0 ? location.slice(0, slash) : "";
    const repoName = slash > 0 ? location.slice(slash + 1) : repository.name;
    if (!owner) {
      const fallbackOwner = config.giteaConfig.defaultOwner;
      owner = await getGiteaRepoOwnerAsync({ config: partial, repository }).catch(
        () => fallbackOwner
      );
    }

    const token = decryptConfigTokens(config as Config).giteaConfig.token;
    const base = `${config.giteaConfig.url.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(
      owner
    )}/${encodeURIComponent(repoName)}/releases`;

    const releases: DestinationRelease[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      const response = await httpGet<DestinationReleaseGitea[]>(
        `${base}?per_page=${PAGE_SIZE}&page=${page}`,
        { Authorization: `token ${token}` }
      ).catch(() => null);
      const batch = response?.data;
      if (!Array.isArray(batch)) {
        if (page === 1) {
          return jsonResponse({
            data: {
              success: false,
              error: `No releases could be read for ${owner}/${repoName} in the destination`,
            },
            status: 404,
          });
        }
        break;
      }
      for (const release of batch) {
        const tag = typeof release.tag_name === "string" ? release.tag_name : "";
        if (!tag) continue;
        releases.push({
          tag,
          prerelease: typeof release.prerelease === "boolean" ? release.prerelease : null,
        });
      }
      if (batch.length < PAGE_SIZE) break;
      if (releases.length >= MAX_RELEASES) {
        truncated = true;
        break;
      }
    }

    return jsonResponse({
      data: {
        success: true,
        destination: `${owner}/${repoName}`,
        releases,
        truncated,
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "List destination releases", 500);
  }
};

/** Shape Gitea reports for one release; only the fields the preview needs. */
type DestinationReleaseGitea = {
  tag_name?: string;
  prerelease?: boolean | null;
};
