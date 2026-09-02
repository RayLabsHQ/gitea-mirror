import type { APIRoute } from "astro";
import { resolveSourceProviderKind } from "@/lib/source-providers";
import { db, configs } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import {
  createGitHubClient,
  getGithubStarredListNames,
} from "@/lib/github";
import { getDecryptedGitHubToken } from "@/lib/utils/config-encryption";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // Prefer active and most-recently-updated config to avoid picking a stale
    // inactive stub when multiple rows exist (see issue #271).
    const [config] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    if (!config) {
      return jsonResponse({
        data: { success: false, message: "No configuration found for this user" },
        status: 404,
      });
    }

    if (!config.githubConfig?.token) {
      return jsonResponse({
        data: { success: false, message: "GitHub token is missing in config" },
        status: 400,
      });
    }

    // Star lists only exist on GitHub. Other sources simply have none.
    if (resolveSourceProviderKind(config) !== "github") {
      return jsonResponse({ data: { success: true, lists: [] }, status: 200 });
    }

    const token = getDecryptedGitHubToken(config);
    const githubUsername = config.githubConfig?.owner || undefined;
    const octokit = createGitHubClient(token, userId, githubUsername);
    const lists = await getGithubStarredListNames({ octokit });

    return jsonResponse({
      data: {
        success: true,
        lists,
      },
      status: 200,
    });
  } catch (error) {
    return createSecureErrorResponse(error, "starred lists fetch", 500);
  }
};
