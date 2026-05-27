import { defineMiddleware } from 'astro:middleware';
import { initializeRecovery, hasJobsNeedingRecovery, getRecoveryStatus } from './lib/recovery';
import { startCleanupService, stopCleanupService } from './lib/cleanup-service';
import { startSchedulerService, stopSchedulerService } from './lib/scheduler-service';
import { startRepositoryCleanupService, stopRepositoryCleanupService } from './lib/repository-cleanup-service';
import { initializeShutdownManager, registerShutdownCallback } from './lib/shutdown-manager';
import { setupSignalHandlers } from './lib/signal-handlers';
import { auth } from './lib/auth';
import { isHeaderAuthEnabled } from './lib/auth-header';
import { mintSessionFromHeaders } from './lib/auth-header-bridge';
import { initializeConfigFromEnv } from './lib/env-config-loader';
import { db, users } from './lib/db';
import { getBasePath } from './lib/base-path';

const ASTRO_INTERNAL_ASSET_PATH_PATTERN = /(["'])\/(_astro\/|_server-islands\/|_image\b)/g;

function prefixAstroInternalAssetPaths(html: string, basePath: string): string {
  return html.replace(ASTRO_INTERNAL_ASSET_PATH_PATTERN, `$1${basePath}/$2`);
}

// Flag to track whether the *startup* recovery pass has run. This
// only gates the post-startup chain (cleanup service, scheduler,
// etc.) and the "startup script may not have run" log line — it does
// NOT gate subsequent recovery attempts, see below.
let recoveryInitialized = false;
// Throttle for runtime recovery retries (separate from the
// initializeRecovery() 5-minute throttle inside recovery.ts, which is
// keyed on `lastRecoveryAttempt`). This prevents one middleware
// invocation from triggering recovery while another is in flight.
let recoveryInFlight = false;
let cleanupServiceStarted = false;
let schedulerServiceStarted = false;
let repositoryCleanupServiceStarted = false;
let shutdownManagerInitialized = false;
let envConfigInitialized = false;
let envConfigCheckCount = 0; // Track attempts to avoid excessive checking

export const onRequest = defineMiddleware(async (context, next) => {
  const basePath = getBasePath();

  // Set-Cookie headers we mint during the header-auth bridge below.
  // Forwarded onto the outbound response after `next()` so the browser
  // persists the Better Auth session cookie. Until that happens the
  // SPA's /api/auth/get-session call returns null and bounces to
  // /login — see the bridge block for the full rationale.
  let pendingSetCookies: string[] = [];

  // First, try Better Auth session (cookie-based)
  try {
    const session = await auth.api.getSession({
      headers: context.request.headers,
    });

    if (session) {
      context.locals.user = session.user;
      context.locals.session = session.session;
    } else if (isHeaderAuthEnabled()) {
      // No cookie session, but header auth is on. Call the
      // header-auth plugin endpoint to mint a real Better Auth
      // session from the trusted upstream headers, then forward the
      // Set-Cookie onto the outbound response so the SPA's next
      // /api/auth/get-session call carries the cookie. Without this
      // bridge the React app sees null on mount and redirects to
      // /login even though server-rendered code paths know the user.
      const bridge = await mintSessionFromHeaders(context.request);
      if (bridge) {
        context.locals.user = bridge.user;
        context.locals.session = bridge.session;
        pendingSetCookies = bridge.setCookies;
      } else {
        context.locals.user = null;
        context.locals.session = null;
      }
    } else {
      context.locals.user = null;
      context.locals.session = null;
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

  // Run recovery if jobs need it.
  //
  // The previous implementation used a once-per-process gate, so
  // any mid-runtime interruption (a sync that started after boot,
  // crashed mid-flight, and never got back to the resume path)
  // would sit at `in_progress=true` forever — the periodic detector
  // kept finding it, but the resumer never re-fired. This block
  // now re-evaluates on every request, gated by `recoveryInFlight`
  // (per-process) plus the 5-minute throttle inside
  // `initializeRecovery()` (which prevents thrashing if a resume
  // cycle keeps failing).
  if (!recoveryInFlight) {
    recoveryInFlight = true;

    try {
      // Check if recovery is actually needed before attempting
      const needsRecovery = await hasJobsNeedingRecovery();

      if (needsRecovery) {
        if (!recoveryInitialized) {
          console.log('⚠️  Middleware detected jobs needing recovery (startup script may not have run)');
        } else {
          console.log('⚠️  Middleware detected jobs needing recovery mid-run (sync interrupted after startup)');
        }
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
      } else if (!recoveryInitialized) {
        // Only log this on the first request; otherwise we'd spam
        // it on every request.
        console.log('✅ No recovery needed (startup script likely handled it)');
      }

      recoveryInitialized = true;
    } catch (error) {
      console.error('⚠️  Middleware recovery failed or timed out:', error);
      console.log('Application will continue, but some jobs may remain interrupted');

      // Log recovery status for debugging
      const status = getRecoveryStatus();
      console.log('Recovery status:', status);

      recoveryInitialized = true;
    } finally {
      recoveryInFlight = false;
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

  // Forward any Set-Cookie headers minted by the header-auth bridge
  // onto the outbound response. Done before the early returns below so
  // every return path (basePath rewrite, non-HTML responses, etc.)
  // carries the cookie. The body-rewrite branch further down clones
  // `response.headers`, so anything appended here survives the clone.
  if (pendingSetCookies.length > 0) {
    for (const cookie of pendingSetCookies) {
      response.headers.append("set-cookie", cookie);
    }
  }

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
