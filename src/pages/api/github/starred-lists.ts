import type { APIRoute } from "astro";
import { db, configs } from "@/lib/db";
import { eq } from "drizzle-orm";
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

    const [config] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
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
