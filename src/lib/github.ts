import type { GitOrg, MembershipRole } from "@/types/organizations";
import type { GitRepo, RepoStatus } from "@/types/Repository";
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import type { Config } from "@/types/config";
// Conditionally import rate limit manager (not available in test environment)
let RateLimitManager: any = null;
let publishEvent: any = null;

if (process.env.NODE_ENV !== "test") {
  try {
    const rateLimitModule = await import("@/lib/rate-limit-manager");
    RateLimitManager = rateLimitModule.RateLimitManager;
    const eventsModule = await import("@/lib/events");
    publishEvent = eventsModule.publishEvent;
  } catch (error) {
    console.warn("Rate limit manager not available:", error);
  }
}

// Extend Octokit with throttling plugin when available (tests may stub Octokit)
// Fallback to base Octokit if .plugin is not present
const MyOctokit: any = (Octokit as any)?.plugin?.call
  ? (Octokit as any).plugin(throttling)
  : (Octokit as any);

/**
 * Creates an authenticated Octokit instance with rate limit tracking and throttling
 */
export function createGitHubClient(
  token: string,
  userId?: string,
  username?: string,
): Octokit {
  // Create a proper User-Agent to identify our application
  // This helps GitHub understand our traffic patterns and can provide better rate limits
  const userAgent = username
    ? `gitea-mirror/3.5.4 (user:${username})`
    : "gitea-mirror/3.5.4";

  const baseUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  console.log("[GitHub Client] Creating client with baseUrl:", baseUrl);

  const octokit = new MyOctokit({
    auth: token, // Always use token for authentication (5000 req/hr vs 60 for unauthenticated)
    userAgent, // Identify our application and user
    baseUrl, // Configurable for E2E testing
    log: {
      debug: () => {},
      info: console.log,
      warn: console.warn,
      error: console.error,
    },
    request: {
      // Add default headers for better identification
      headers: {
        accept: "application/vnd.github.v3+json",
        "x-github-api-version": "2022-11-28", // Use a stable API version
      },
    },
    throttle: {
      onRateLimit: async (
        retryAfter: number,
        options: any,
        octokit: any,
        retryCount: number,
      ) => {
        const isSearch = options.url.includes("/search/");
        const maxRetries = isSearch ? 5 : 3; // Search endpoints get more retries

        console.warn(
          `[GitHub] Rate limit hit for ${options.method} ${options.url}. Retry ${retryCount + 1}/${maxRetries}`,
        );

        // Update rate limit status and notify UI (if available)
        if (userId && RateLimitManager) {
          await RateLimitManager.updateFromResponse(userId, {
            "retry-after": retryAfter.toString(),
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": (Date.now() / 1000 + retryAfter).toString(),
          });
        }

        if (userId && publishEvent) {
          await publishEvent({
            userId,
            channel: "rate-limit",
            payload: {
              type: "rate-limited",
              provider: "github",
              retryAfter,
              retryCount,
              endpoint: options.url,
              message: `Rate limit hit. Waiting ${retryAfter}s before retry ${retryCount + 1}/${maxRetries}...`,
            },
          });
        }

        // Retry with exponential backoff
        if (retryCount < maxRetries) {
          console.log(`[GitHub] Waiting ${retryAfter}s before retry...`);
          return true;
        }

        // Max retries reached
        console.error(
          `[GitHub] Max retries (${maxRetries}) reached for ${options.url}`,
        );
        return false;
      },
      onSecondaryRateLimit: async (
        retryAfter: number,
        options: any,
        octokit: any,
        retryCount: number,
      ) => {
        console.warn(
          `[GitHub] Secondary rate limit hit for ${options.method} ${options.url}`,
        );

        // Update status and notify UI (if available)
        if (userId && publishEvent) {
          await publishEvent({
            userId,
            channel: "rate-limit",
            payload: {
              type: "secondary-limited",
              provider: "github",
              retryAfter,
              retryCount,
              endpoint: options.url,
              message: `Secondary rate limit hit. Waiting ${retryAfter}s...`,
            },
          });
        }

        // Retry up to 2 times for secondary rate limits
        if (retryCount < 2) {
          console.log(
            `[GitHub] Waiting ${retryAfter}s for secondary rate limit...`,
          );
          return true;
        }

        return false;
      },
      // Throttle options to prevent hitting limits
      fallbackSecondaryRateRetryAfter: 60, // Wait 60s on secondary rate limit
      minimumSecondaryRateRetryAfter: 5, // Min 5s wait
      retryAfterBaseValue: 1000, // Base retry in ms
    },
  });

  // Add logging hooks for debugging
  octokit.hook.before("request", async (options: any) => {
    console.log(`[GitHub Request] ${options.method} ${options.url}`);
  });
  
  octokit.hook.after("request", async (response: any, options: any) => {
    console.log(`[GitHub Response] ${options.method} ${options.url} -> ${response.status}`);
    // Update rate limit from response headers
    if (userId && RateLimitManager && response.headers) {
      await RateLimitManager.updateFromResponse(userId, response.headers);
    }
  });
  
  octokit.hook.error("request", async (error: any, options: any) => {
    console.error(`[GitHub Error] ${options.method} ${options.url} -> ${error.status}: ${error.message}`);
    
    // Handle rate limit errors
    if (userId && (error.status === 403 || error.status === 429)) {
      const message = error.message || "";
      if (message.includes("rate limit") || message.includes("API rate limit")) {
        console.error(`[GitHub] Rate limit error for user ${userId}: ${message}`);
        
        // Update rate limit status from error response (if available)
        if (error.response?.headers && RateLimitManager) {
          await RateLimitManager.updateFromResponse(userId, error.response.headers);
        }
        
        // Create error event for UI (if available)
        if (publishEvent) {
          await publishEvent({
            userId,
            channel: "rate-limit",
            payload: {
              type: "error",
              provider: "github",
              error: message,
              endpoint: options.url,
              message: `Rate limit exceeded: ${message}`,
            },
          });
        }
      }
    }
    
    throw error;
  });

  return octokit;
}

/**
 * Clone a repository from GitHub
 */
export async function getGithubRepoCloneUrl({
  octokit,
  owner,
  repo,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
}): Promise<{ url: string; cloneUrl: string }> {
  const { data } = await octokit.repos.get({
    owner,
    repo,
  });

  return {
    url: data.html_url,
    cloneUrl: data.clone_url,
  };
}

/**
 * Get user repositories from GitHub
 * todo: need to handle pagination and apply more filters based on user config
 */
export async function getGithubRepositories({
  octokit,
  config,
}: {
  octokit: Octokit;
  config: Partial<Config>;
}): Promise<GitRepo[]> {
  try {
    const repos = await octokit.paginate(
      octokit.repos.listForAuthenticatedUser,
      { per_page: 100 },
    );

    const skipForks = config.githubConfig?.skipForks ?? false;

    const filteredRepos = repos.filter((repo) => {
      const isForkAllowed = !skipForks || !repo.fork;
      return isForkAllowed;
    });

    return filteredRepos.map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      url: repo.html_url,
      cloneUrl: repo.clone_url,

      owner: repo.owner.login,
      organization:
        repo.owner.type === "Organization" ? repo.owner.login : undefined,
      mirroredLocation: "",
      destinationOrg: null,

      isPrivate: repo.private,
      isForked: repo.fork,
      forkedFrom: (repo as typeof repo & { parent?: { full_name: string } })
        .parent?.full_name,

      hasIssues: repo.has_issues,
      isStarred: false,
      isArchived: repo.archived,

      size: repo.size,
      hasLFS: false,
      hasSubmodules: false,

      language: repo.language,
      description: repo.description,
      defaultBranch: repo.default_branch,
      visibility: (repo.visibility ?? "public") as GitRepo["visibility"],

      status: "imported",
      isDisabled: repo.disabled ?? false,
      lastMirrored: undefined,
      errorMessage: undefined,

      createdAt: repo.created_at ? new Date(repo.created_at) : new Date(),
      updatedAt: repo.updated_at ? new Date(repo.updated_at) : new Date(),
    }));
  } catch (error) {
    throw new Error(
      `Error fetching repositories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function getGithubStarredRepositories({
  octokit,
  config,
}: {
  octokit: Octokit;
  config: Partial<Config>;
}): Promise<GitRepo[]> {
  try {
    const starredRepos = await octokit.paginate(
      octokit.activity.listReposStarredByAuthenticatedUser,
      {
        per_page: 100,
      },
    );

    return starredRepos.map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      url: repo.html_url,
      cloneUrl: repo.clone_url,

      owner: repo.owner.login,
      organization:
        repo.owner.type === "Organization" ? repo.owner.login : undefined,
      mirroredLocation: "",
      destinationOrg: null,

      isPrivate: repo.private,
      isForked: repo.fork,
      forkedFrom: undefined,

      hasIssues: repo.has_issues,
      isStarred: true,
      isArchived: repo.archived,

      size: repo.size,
      hasLFS: false, // Placeholder
      hasSubmodules: false, // Placeholder

      language: repo.language,
      description: repo.description,
      defaultBranch: repo.default_branch,
      visibility: (repo.visibility ?? "public") as GitRepo["visibility"],

      status: "imported",
      isDisabled: repo.disabled ?? false,
      lastMirrored: undefined,
      errorMessage: undefined,

      createdAt: repo.created_at ? new Date(repo.created_at) : new Date(),
      updatedAt: repo.updated_at ? new Date(repo.updated_at) : new Date(),
    }));
  } catch (error) {
    throw new Error(
      `Error fetching starred repositories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Get user github organizations
 */
export async function getGithubOrganizations({
  octokit,
  config,
}: {
  octokit: Octokit;
  config: Partial<Config>;
}): Promise<GitOrg[]> {
  try {
    const { data: orgs } = await octokit.orgs.listForAuthenticatedUser({
      per_page: 100,
    });

    // Get excluded organizations from environment variable
    const excludedOrgsEnv = process.env.GITHUB_EXCLUDED_ORGS;
    const excludedOrgs = excludedOrgsEnv
      ? excludedOrgsEnv.split(",").map((org) => org.trim().toLowerCase())
      : [];

    // Filter out excluded organizations
    const filteredOrgs = orgs.filter((org) => {
      if (excludedOrgs.includes(org.login.toLowerCase())) {
        console.log(
          `Skipping organization ${org.login} - excluded via GITHUB_EXCLUDED_ORGS environment variable`,
        );
        return false;
      }
      return true;
    });

    const organizations = await Promise.all(
      filteredOrgs.map(async (org) => {
        const [{ data: orgDetails }, { data: membership }] = await Promise.all([
          octokit.orgs.get({ org: org.login }),
          octokit.orgs.getMembershipForAuthenticatedUser({ org: org.login }),
        ]);

        const totalRepos =
          orgDetails.public_repos + (orgDetails.total_private_repos ?? 0);

        return {
          name: org.login,
          avatarUrl: org.avatar_url,
          membershipRole: membership.role as MembershipRole,
          isIncluded: false,
          status: "imported" as RepoStatus,
          repositoryCount: totalRepos,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }),
    );

    return organizations;
  } catch (error) {
    throw new Error(
      `Error fetching organizations: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Get repositories for a specific organization
 */
export async function getGithubOrganizationRepositories({
  octokit,
  organizationName,
}: {
  octokit: Octokit;
  organizationName: string;
}): Promise<GitRepo[]> {
  try {
    const repos = await octokit.paginate(octokit.repos.listForOrg, {
      org: organizationName,
      per_page: 100,
    });

    return repos.map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      url: repo.html_url,
      cloneUrl: repo.clone_url ?? "",

      owner: repo.owner.login,
      organization: repo.owner.login,
      mirroredLocation: "",
      destinationOrg: null,

      isPrivate: repo.private,
      isForked: repo.fork,
      forkedFrom: (repo as typeof repo & { parent?: { full_name: string } })
        .parent?.full_name,

      hasIssues: repo.has_issues ?? false,
      isStarred: false, // Organization starred repos are separate API
      isArchived: repo.archived ?? false,

      size: repo.size ?? 0,
      hasLFS: false,
      hasSubmodules: false,

      language: repo.language,
      description: repo.description,
      defaultBranch: repo.default_branch ?? "main",
      visibility: (repo.visibility ?? "public") as GitRepo["visibility"],

      status: "imported",
      isDisabled: repo.disabled ?? false,
      lastMirrored: undefined,
      errorMessage: undefined,

      createdAt: repo.created_at ? new Date(repo.created_at) : new Date(),
      updatedAt: repo.updated_at ? new Date(repo.updated_at) : new Date(),
    }));
  } catch (error) {
    throw new Error(
      `Error fetching organization repositories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
