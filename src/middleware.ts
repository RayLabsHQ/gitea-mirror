import { defineMiddleware } from 'astro:middleware';
import { initializeRecovery, hasJobsNeedingRecovery, getRecoveryStatus } from './lib/recovery';
import { startCleanupService, stopCleanupService } from './lib/cleanup-service';
import { startSchedulerService, stopSchedulerService } from './lib/scheduler-service';
import { startRepositoryCleanupService, stopRepositoryCleanupService } from './lib/repository-cleanup-service';
import { initializeShutdownManager, registerShutdownCallback } from './lib/shutdown-manager';
import { setupSignalHandlers } from './lib/signal-handlers';
import { auth } from './lib/auth';
import { isHeaderAuthEnabled, authenticateWithHeaders } from './lib/auth-header';
import { initializeConfigFromEnv } from './lib/env-config-loader';
import { db, users } from './lib/db';
import { getBasePath } from './lib/base-path';

const ASTRO_INTERNAL_ASSET_PATH_PATTERN = /(["'])\/(_astro\/|_server-islands\/|_image\b)/g;

function prefixAstroInternalAssetPaths(html: string, basePath: string): string {
  return html.replace(ASTRO_INTERNAL_ASSET_PATH_PATTERN, `$1${basePath}/$2`);
}

// Flag to track if recovery has been initialized
let recoveryInitialized = false;
let recoveryAttempted = false;
let cleanupServiceStarted = false;
let schedulerServiceStarted = false;
let repositoryCleanupServiceStarted = false;
let shutdownManagerInitialized = false;
let envConfigInitialized = false;
let envConfigCheckCount = 0; // Track attempts to avoid excessive checking

export const onRequest = defineMiddleware(async (context, next) => {
  const basePath = getBasePath();

  // First, try Better Auth session (cookie-based)
  try {
    const session = await auth.api.getSession({
      headers: context.request.headers,
    });

    if (session) {
      context.locals.user = session.user;
      context.locals.session = session.session;
    } else {
      // No cookie session, check for header authentication
      if (isHeaderAuthEnabled()) {
        const headerUser = await authenticateWithHeaders(context.request.headers);
        if (headerUser) {
          // Create a session-like object for header auth
          context.locals.user = {
            id: headerUser.id,
            email: headerUser.email,
            emailVerified: headerUser.emailVerified,
            name: headerUser.name || headerUser.username,
            username: headerUser.username,
            createdAt: headerUser.createdAt,
            updatedAt: headerUser.updatedAt,
          };
          context.locals.session = {
            id: `header-${headerUser.id}`,
            userId: headerUser.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day
            ipAddress: context.request.headers.get('x-forwarded-for') || context.clientAddress,
            userAgent: context.request.headers.get('user-agent'),
          };
        } else {
          context.locals.user = null;
          context.locals.session = null;
        }
      } else {
        context.locals.user = null;
        context.locals.session = null;
      }
    }
  } catch (error) {
    // If there's an error getting the session, set to null
    context.locals.user = null;
    context.locals.session = null;
  }

  // Initialize shutdown manager and signal handlers first
  if (!shutdownManagerInitialized) {
    try {
      console.log('🔧 Initializing shutdown manager and signal handlers...');
      initializeShutdownManager();
      setupSignalHandlers();
      shutdownManagerInitialized = true;
      console.log('✅ Shutdown manager and signal handlers initialized');
    } catch (error) {
      console.error('❌ Failed to initialize shutdown manager:', error);
      // Continue anyway - this shouldn't block the application
    }
  }

  // Initialize configuration from environment variables
  // Optimized to minimize performance impact:
  // - Once initialized, no checks are performed (envConfigInitialized = true)
  // - Limits checks to first 100 requests to avoid DB queries on every request if no users exist
  // - After user creation, env vars load on next request and flag is set permanently
  if (!envConfigInitialized && envConfigCheckCount < 100) {
    envConfigCheckCount++;
    
    // Only check every 10th request after the first 10 to reduce DB load
    const shouldCheck = envConfigCheckCount <= 10 || envConfigCheckCount % 10 === 0;
    
    if (shouldCheck) {
      try {
        const hasUsers = await db.select().from(users).limit(1).then(u => u.length > 0);
        
        if (hasUsers) {
          // We have users now, try to initialize config
          await initializeConfigFromEnv();
          envConfigInitialized = true; // This ensures we never check again
          console.log('✅ Environment configuration loaded after user creation');
        }
      } catch (error) {
        console.error('⚠️  Failed to initialize configuration from environment:', error);
        // Continue anyway - environment config is optional
      }
    }
  }

  // Initialize recovery system only once when the server starts
  // This is a fallback in case the startup script didn't run
  if (!recoveryInitialized && !recoveryAttempted) {
    recoveryAttempted = true;

    try {
      // Check if recovery is actually needed before attempting
      const needsRecovery = await hasJobsNeedingRecovery();

      if (needsRecovery) {
        console.log('⚠️  Middleware detected jobs needing recovery (startup script may not have run)');
        console.log('Attempting recovery from middleware...');

        // Run recovery with a shorter timeout since this is during request handling
        const recoveryResult = await Promise.race([
          initializeRecovery({
            skipIfRecentAttempt: true,
            maxRetries: 2,
            retryDelay: 3000,
          }),
          new Promise<boolean>((_, reject) => {
            setTimeout(() => reject(new Error('Middleware recovery timeout')), 15000);
          })
        ]);

        if (recoveryResult) {
          console.log('✅ Middleware recovery completed successfully');
        } else {
          console.log('⚠️  Middleware recovery completed with some issues');
        }
      } else {
        console.log('✅ No recovery needed (startup script likely handled it)');
      }

      recoveryInitialized = true;
    } catch (error) {
      console.error('⚠️  Middleware recovery failed or timed out:', error);
      console.log('Application will continue, but some jobs may remain interrupted');

      // Log recovery status for debugging
      const status = getRecoveryStatus();
      console.log('Recovery status:', status);

      recoveryInitialized = true; // Mark as attempted to avoid retries
    }
  }

  // Start cleanup service only once after recovery is complete
  if (recoveryInitialized && !cleanupServiceStarted) {
    try {
      console.log('Starting automatic database cleanup service...');
      startCleanupService();

      // Register cleanup service shutdown callback
      registerShutdownCallback(async () => {
        console.log('🛑 Shutting down cleanup service...');
        stopCleanupService();
      });

      cleanupServiceStarted = true;
    } catch (error) {
      console.error('Failed to start cleanup service:', error);
      // Don't fail the request if cleanup service fails to start
    }
  }

  // Start scheduler service only once after recovery is complete
  if (recoveryInitialized && !schedulerServiceStarted) {
    try {
      console.log('Starting automatic mirror scheduler service...');
      // Start the scheduler service (now async)
      startSchedulerService().catch(error => {
        console.error('Error in scheduler service startup:', error);
      });

      // Register scheduler service shutdown callback
      registerShutdownCallback(async () => {
        console.log('🛑 Shutting down scheduler service...');
        stopSchedulerService();
      });

      schedulerServiceStarted = true;
    } catch (error) {
      console.error('Failed to start scheduler service:', error);
      // Don't fail the request if scheduler service fails to start
    }
  }

  // Start repository cleanup service only once after recovery is complete
  if (recoveryInitialized && !repositoryCleanupServiceStarted) {
    try {
      console.log('Starting repository cleanup service...');
      startRepositoryCleanupService();

      // Register repository cleanup service shutdown callback
      registerShutdownCallback(async () => {
        console.log('🛑 Shutting down repository cleanup service...');
        stopRepositoryCleanupService();
      });

      repositoryCleanupServiceStarted = true;
    } catch (error) {
      console.error('Failed to start repository cleanup service:', error);
      // Don't fail the request if repository cleanup service fails to start
    }
  }

  // Continue with the request
  const response = await next();

  if (basePath === "/") {
    return response;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  const body = await response.text();
  const rewrittenBody = prefixAstroInternalAssetPaths(body, basePath);
  if (rewrittenBody === body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(rewrittenBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
