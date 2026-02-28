import type { APIRoute } from "astro";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { db } from "@/lib/db";
import { ENV } from "@/lib/config";
import { getRecoveryStatus, hasJobsNeedingRecovery } from "@/lib/recovery";
import os from "os";
import { httpGet } from "@/lib/http-client";

// Track when the server started
const serverStartTime = new Date();

// Cache for the latest version to avoid frequent GitHub API calls
interface VersionCache {
  latestVersion: string;
  timestamp: number;
}

let versionCache: VersionCache | null = null;
const CACHE_TTL = 3600000; // 1 hour in milliseconds

export const GET: APIRoute = async () => {
  try {
    // Check database connection by running a simple query
    const dbStatus = await checkDatabaseConnection();

    // Get system information
    const systemInfo = {
      uptime: getUptime(),
      memory: getMemoryUsage(),
      os: {
        platform: os.platform(),
        version: os.version(),
        arch: os.arch(),
      },
      env: ENV.NODE_ENV,
    };

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

    // Build response
    const healthData = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: currentVersion,
      latestVersion: latestVersion,
      updateAvailable: latestVersion !== "unknown" &&
                       currentVersion !== "unknown" &&
                       compareVersions(currentVersion, latestVersion) < 0,
      database: dbStatus,
      recovery: recoveryStatus,
      system: systemInfo,
      debug: {
        GH_API_URL: process.env.GH_API_URL || "(not set)",
        GITHUB_API_URL: process.env.GITHUB_API_URL || "(not set)",
        NODE_ENV: process.env.NODE_ENV || "(not set)",
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
 * Get server uptime information
 */
function getUptime() {
  const now = new Date();
  const uptimeMs = now.getTime() - serverStartTime.getTime();

  // Convert to human-readable format
  const seconds = Math.floor(uptimeMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  return {
    startTime: serverStartTime.toISOString(),
    uptimeMs,
    formatted: `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`,
  };
}

/**
 * Get memory usage information
 */
function getMemoryUsage() {
  const memoryUsage = process.memoryUsage();

  return {
    rss: formatBytes(memoryUsage.rss),
    heapTotal: formatBytes(memoryUsage.heapTotal),
    heapUsed: formatBytes(memoryUsage.heapUsed),
    external: formatBytes(memoryUsage.external),
    systemTotal: formatBytes(os.totalmem()),
    systemFree: formatBytes(os.freemem()),
  };
}

/**
 * Format bytes to human-readable format
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
async function checkLatestVersion(): Promise<string> {
  // Return cached version if available and not expired
  if (versionCache && (Date.now() - versionCache.timestamp) < CACHE_TTL) {
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

    // Update cache
    versionCache = {
      latestVersion,
      timestamp: Date.now()
    };

    return latestVersion;
  } catch (error) {
    console.error('Failed to check for latest version:', error);
    return 'unknown';
  }
}

// Import sql tag for raw SQL queries
import { sql } from "drizzle-orm";
