import { defineMiddleware } from 'astro:middleware';
import { initializeRecovery, hasJobsNeedingRecovery, getRecoveryStatus } from './lib/recovery';
import { startCleanupService, stopCleanupService } from './lib/cleanup-service';
import { initializeShutdownManager, registerShutdownCallback } from './lib/shutdown-manager';
import { setupSignalHandlers } from './lib/signal-handlers';
import { runMigrations, checkMigrationsNeeded } from './lib/db/migrations';
import { authenticate, isAuthRequired, getAuthRedirectUrl } from './lib/auth/middleware';

// Flag to track if recovery has been initialized
let recoveryInitialized = false;
let recoveryAttempted = false;
let cleanupServiceStarted = false;
let shutdownManagerInitialized = false;
let migrationsRun = false;

export const onRequest = defineMiddleware(async (context, next) => {
  // Run database migrations first (only once)
  if (!migrationsRun) {
    try {
      if (checkMigrationsNeeded()) {
        console.log('🔄 Database migrations needed, running...');
        const migrationResult = await runMigrations();
        if (migrationResult) {
          console.log('✅ Database migrations completed successfully');
        } else {
          console.log('⚠️  Database migrations completed with issues');
        }
      }
      migrationsRun = true;
    } catch (error) {
      console.error('❌ Failed to run database migrations:', error);
      // Continue anyway - this shouldn't block the application
      migrationsRun = true;
    }
  }

  // Initialize shutdown manager and signal handlers
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

  // Authentication check
  const pathname = context.url.pathname;
  
  // Check if authentication is required for this path
  if (isAuthRequired(pathname)) {
    const auth = await authenticate(context.request);
    
    if (!auth) {
      // No valid authentication found, redirect to appropriate login
      const redirectUrl = await getAuthRedirectUrl(context.request);
      
      // For API endpoints, return 401 instead of redirecting
      if (pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return context.redirect(redirectUrl);
    }
    
    // Store authenticated user in locals for use in pages/endpoints
    context.locals.user = auth.user;
    context.locals.authMethod = auth.method;
  }

  // Continue with the request
  return next();
});
