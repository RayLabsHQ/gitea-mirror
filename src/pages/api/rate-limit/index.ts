import type { APIRoute } from "astro";
import { db, rateLimits } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { RateLimitManager } from "@/lib/rate-limit-manager";
import { createGitHubClient } from "@/lib/github";
import { getDecryptedGitHubToken } from "@/lib/utils/config-encryption";
import { configs } from "@/lib/db";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAuthenticatedUserId({ request, locals });
  if ("response" in authResult) return authResult.response;
  const userId = authResult.userId;

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "true";

  try {
    // If refresh is requested, fetch current rate limit from GitHub
    if (refresh) {
      const [config] = await db
        .select()
        .from(configs)
        .where(eq(configs.userId, userId))
        .limit(1);

      if (config && config.githubConfig?.token) {
        const decryptedToken = getDecryptedGitHubToken(config);
        const githubUsername = config.githubConfig?.owner || undefined;
        const octokit = createGitHubClient(decryptedToken, userId, githubUsername);
        
        // This will update the rate limit in the database
        await RateLimitManager.checkGitHubRateLimit(octokit, userId);
      }
    }

    // Get rate limit status from database
    const [rateLimit] = await db
      .select()
      .from(rateLimits)
      .where(and(eq(rateLimits.userId, userId), eq(rateLimits.provider, "github")))
      .orderBy(desc(rateLimits.updatedAt))
      .limit(1);

    if (!rateLimit) {
      return jsonResponse({
        data: {
          limit: 5000,
          remaining: 5000,
          used: 0,
          reset: new Date(Date.now() + 3600000), // 1 hour from now
          status: "ok",
          lastChecked: new Date(),
          message: "No rate limit data available yet",
        },
      });
    }

    // Calculate percentage
    const percentage = Math.round((rateLimit.remaining / rateLimit.limit) * 100);
    
    // Calculate time until reset
    const now = new Date();
    const resetTime = new Date(rateLimit.reset);
    const timeUntilReset = Math.max(0, resetTime.getTime() - now.getTime());
    const minutesUntilReset = Math.ceil(timeUntilReset / 60000);

    let message = "";
    switch (rateLimit.status) {
      case "exceeded":
        message = `Rate limit exceeded. Resets in ${minutesUntilReset} minutes.`;
        break;
      case "limited":
        message = `Rate limit critical: ${rateLimit.remaining}/${rateLimit.limit} (${percentage}%)`;
        break;
      case "warning":
        message = `Rate limit warning: ${rateLimit.remaining}/${rateLimit.limit} (${percentage}%)`;
        break;
      default:
        message = `Rate limit healthy: ${rateLimit.remaining}/${rateLimit.limit} (${percentage}%)`;
    }

    return jsonResponse({
      data: {
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
        used: rateLimit.used,
        reset: rateLimit.reset,
        retryAfter: rateLimit.retryAfter,
        status: rateLimit.status,
        lastChecked: rateLimit.lastChecked,
        percentage,
        minutesUntilReset,
        message,
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "rate limit check", 500);
  }
};
