import type { APIRoute } from "astro";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { db } from "@/lib/db";
import { getRecoveryStatus, hasJobsNeedingRecovery } from "@/lib/recovery";
import { httpGet } from "@/lib/http-client";

// Cache for the latest version to avoid frequent GitHub API calls. Failures
// are cached too: the health check runs every few seconds in Docker, and
// retrying a failed lookup each time burns through GitHub's anonymous limit
// of 60 requests an hour, which keeps the lookup failing.
interface VersionCache {
  latestVersion: string;
  expiresAt: number;
}

let versionCache: VersionCache | null = null;
const CACHE_TTL = 3600000; // 1 hour in milliseconds
const FAILURE_CACHE_TTL = 900000; // 15 minutes in milliseconds

/** Clears the latest version cache. For tests only. */
export function resetVersionCache(): void {
  versionCache = null;
}

export const GET: APIRoute = async () => {
  try {
    // Check database connection by running a simple query
    const dbStatus = await checkDatabaseConnection();

    // Get current and latest versions
    const currentVersion = process.env.npm_package_version || "unknown";
    const latestVersion = await checkLatestVersion();

    // Get recovery system status
    const recoveryStatus = await getRecoverySystemStatus();

    // Determine overall health status
    let overallStatus = "ok";
    if (!dbStatus.connected) {
      overallStatus = "error";
    } else if (recoveryStatus.jobsNeedingRecovery > 0 && !recoveryStatus.inProgress) {
      overallStatus = "degraded";
    }

    // Build response (no OS/memory details to avoid information disclosure)
    const healthData = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: currentVersion,
      latestVersion: latestVersion,
      updateAvailable: latestVersion !== "unknown" &&
                       currentVersion !== "unknown" &&
                       compareVersions(currentVersion, latestVersion) < 0,
      database: { connected: dbStatus.connected },
      recovery: {
        status: recoveryStatus.status,
        jobsNeedingRecovery: recoveryStatus.jobsNeedingRecovery,
      },
    };

    return jsonResponse({
      data: healthData,
      status: 200,
    });
  } catch (error) {
    return createSecureErrorResponse(error, "health check", 503);
  }
};

/**
 * Check database connection by running a simple query
 */
async function checkDatabaseConnection() {
  try {
    // Run a simple query to check if the database is accessible
    const result = await db.select({ test: sql`1` }).from(sql`sqlite_master`).limit(1);

    return {
      connected: true,
      message: "Database connection successful",
    };
  } catch (error) {
    console.error("Database connection check failed:", error);

    return {
      connected: false,
      message: error instanceof Error ? error.message : "Database connection failed",
    };
  }
}

/**
 * Get recovery system status
 */
async function getRecoverySystemStatus() {
  try {
    const recoveryStatus = getRecoveryStatus();
    const needsRecovery = await hasJobsNeedingRecovery();

    return {
      status: needsRecovery ? 'jobs-pending' : 'healthy',
      inProgress: recoveryStatus.inProgress,
      lastAttempt: recoveryStatus.lastAttempt?.toISOString() || null,
      jobsNeedingRecovery: needsRecovery ? 1 : 0, // Simplified count for health check
      message: needsRecovery
        ? 'Jobs found that need recovery'
        : 'No jobs need recovery',
    };
  } catch (error) {
    console.error('Recovery system status check failed:', error);

    return {
      status: 'error',
      inProgress: false,
      lastAttempt: null,
      jobsNeedingRecovery: -1,
      message: error instanceof Error ? error.message : 'Recovery status check failed',
    };
  }
}

/**
 * Compare semantic versions
 * Returns: 
 *  -1 if v1 < v2
 *   0 if v1 = v2
 *   1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    
    if (part1 < part2) return -1;
    if (part1 > part2) return 1;
  }
  
  return 0;
}

/**
 * Check for the latest version from GitHub releases
 */
export async function checkLatestVersion(): Promise<string> {
  const now = Date.now();
  // Return cached result (success or failure) if not expired
  if (versionCache && now < versionCache.expiresAt) {
    return versionCache.latestVersion;
  }

  try {
    // Fetch the latest release from GitHub
    const response = await httpGet(
      'https://api.github.com/repos/RayLabsHQ/gitea-mirror/releases/latest',
      { 'Accept': 'application/vnd.github.v3+json' }
    );

    // Extract version from tag_name (remove 'v' prefix if present)
    const latestVersion = response.data.tag_name.replace(/^v/, '');

    versionCache = { latestVersion, expiresAt: now + CACHE_TTL };
    return latestVersion;
  } catch (error) {
    console.error('Failed to check for latest version:', error);
    // Keep the last known version, and do not ask again until the failure
    // window has passed.
    versionCache = {
      latestVersion: versionCache?.latestVersion ?? 'unknown',
      expiresAt: now + FAILURE_CACHE_TTL,
    };
    return versionCache.latestVersion;
  }
}

// Import sql tag for raw SQL queries
import { sql } from "drizzle-orm";
