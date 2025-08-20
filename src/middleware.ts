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

// Flag to track if recovery has been initialized
let recoveryInitialized = false;
let recoveryAttempted = false;
let cleanupServiceStarted = false;
let schedulerServiceStarted = false;
let repositoryCleanupServiceStarted = false;
let shutdownManagerInitialized = false;
let envConfigInitialized = false;

export const onRequest = defineMiddleware(async (context, next) => {
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

  // Initialize configuration from environment variables (only once)
  if (!envConfigInitialized) {
    envConfigInitialized = true;
    try {
      await initializeConfigFromEnv();
    } catch (error) {
      console.error('⚠️  Failed to initialize configuration from environment:', error);
      // Continue anyway - environment config is optional
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
      startSchedulerService();

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
  return next();
});
