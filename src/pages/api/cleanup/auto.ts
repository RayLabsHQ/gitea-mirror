/**
 * API endpoint to manually trigger automatic cleanup
 * This is useful for testing and debugging the cleanup service
 */

import type { APIRoute } from 'astro';
import { runAutomaticCleanup } from '@/lib/cleanup-service';
import { createSecureErrorResponse } from '@/lib/utils';
import { requireAuthenticatedUserId } from '@/lib/auth-guards';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    console.log('Manual cleanup trigger requested');

    // Run the automatic cleanup
    const results = await runAutomaticCleanup();

    // Calculate totals
    const totalEventsDeleted = results.reduce((sum, result) => sum + result.eventsDeleted, 0);
    const totalJobsDeleted = results.reduce((sum, result) => sum + result.mirrorJobsDeleted, 0);
    const errors = results.filter(result => result.error);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Automatic cleanup completed',
        results: {
          usersProcessed: results.length,
          totalEventsDeleted,
          totalJobsDeleted,
          errors: errors.length,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "cleanup trigger", 500);
  }
};

export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify({
      success: false,
      message: 'Use POST method to trigger cleanup',
    }),
    {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
};
