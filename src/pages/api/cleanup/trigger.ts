import type { APIRoute } from 'astro';
import { auth } from '@/lib/auth';
import { createSecureErrorResponse } from '@/lib/utils';
import { RepositoryCleanupBusyError, triggerRepositoryCleanup } from '@/lib/repository-cleanup-service';
import { requireAuthenticatedUserId } from '@/lib/auth-guards';

/**
 * Run repository cleanup for the current user now: the Run now button on the
 * Repository Cleanup card (#547). It checks the sources for repositories that
 * are gone and applies the configured action, or only logs it in dry run.
 */
export const POST: APIRoute = async (context) => {
  try {
    const authResult = await requireAuthenticatedUserId(context);
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    console.log(`[Cleanup API] Manual cleanup triggered for user ${userId}`);

    const results = await triggerRepositoryCleanup(userId);

    console.log(`[Cleanup API] Cleanup completed: ${results.processedCount}/${results.orphanedCount} repositories processed, ${results.errors.length} errors`);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Repository cleanup completed',
        results: {
          orphanedCount: results.orphanedCount,
          processedCount: results.processedCount,
          errorCount: results.errors.length,
          errors: results.errors,
          repositories: results.repositories,
          waiting: results.waiting,
          leftAlone: results.leftAlone,
          dryRun: results.dryRun,
          action: results.action,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    if (error instanceof RepositoryCleanupBusyError) {
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }
    console.error('[Cleanup API] Error during manual cleanup:', error);
    return createSecureErrorResponse(error, 'manual cleanup', 500);
  }
};

/**
 * Get cleanup status and configuration for the current user
 */
export const GET: APIRoute = async ({ request }) => {
  try {
    // Get user session
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user?.id) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Import inside the function to avoid import issues
    const { db, configs } = await import('@/lib/db');
    const { eq, and } = await import('drizzle-orm');

    // Get user's cleanup configuration
    const [config] = await db
      .select()
      .from(configs)
      .where(and(
        eq(configs.userId, session.user.id),
        eq(configs.isActive, true)
      ))
      .limit(1);

    if (!config) {
      return new Response(
        JSON.stringify({
          success: false,
          message: 'No active configuration found',
          cleanupEnabled: false,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const cleanupConfig = config.cleanupConfig || {};
    const isCleanupEnabled = cleanupConfig.enabled || cleanupConfig.deleteIfNotInGitHub;

    return new Response(
      JSON.stringify({
        success: true,
        cleanupEnabled: isCleanupEnabled,
        configuration: {
          enabled: cleanupConfig.enabled,
          deleteFromGitea: cleanupConfig.deleteFromGitea,
          deleteIfNotInGitHub: cleanupConfig.deleteIfNotInGitHub,
          dryRun: cleanupConfig.dryRun,
          orphanedRepoAction: cleanupConfig.orphanedRepoAction || 'archive',
          lastRun: cleanupConfig.lastRun,
          nextRun: cleanupConfig.nextRun,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[Cleanup API] Error getting cleanup status:', error);
    return createSecureErrorResponse(error, 'cleanup status', 500);
  }
};