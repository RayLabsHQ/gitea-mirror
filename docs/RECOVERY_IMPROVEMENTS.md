# Job Recovery and Resume Process Improvements

This document outlines the comprehensive improvements made to the job recovery and resume process to make it more robust to application restarts, container restarts, and application crashes.

## Problems Addressed

The original recovery system had several critical issues:

1. **Middleware-based initialization**: Recovery only ran when the first request came in
2. **Database connection issues**: No validation of database connectivity before recovery attempts
3. **Limited error handling**: Insufficient error handling for various failure scenarios
4. **No startup recovery**: No mechanism to handle recovery before serving requests
5. **Incomplete job state management**: Jobs could remain in inconsistent states
6. **No retry mechanisms**: Single-attempt recovery with no fallback strategies

## Improvements Implemented

### 1. Enhanced Recovery System (`src/lib/recovery.ts`)

#### New Features:
- **Database connection validation** before attempting recovery
- **Stale job cleanup** for jobs older than 24 hours
- **Retry mechanisms** with configurable attempts and delays
- **Individual job error handling** to prevent one failed job from stopping recovery
- **Recovery state tracking** to prevent concurrent recovery attempts
- **Enhanced logging** with detailed job information

#### Key Functions:
- `initializeRecovery()` - Main recovery function with enhanced error handling
- `validateDatabaseConnection()` - Ensures database is accessible
- `cleanupStaleJobs()` - Removes jobs that are too old to recover
- `getRecoveryStatus()` - Returns current recovery system status
- `forceRecovery()` - Bypasses recent attempt checks
- `hasJobsNeedingRecovery()` - Checks if recovery is needed

### 2. Startup Recovery Script (`scripts/startup-recovery.ts`)

A dedicated script that runs recovery before the application starts serving requests:

#### Features:
- **Timeout protection** (default: 30 seconds)
- **Force recovery option** to bypass recent attempt checks
- **Graceful signal handling** (SIGINT, SIGTERM)
- **Detailed logging** with progress indicators
- **Exit codes** for different scenarios (success, warnings, errors)

#### Usage:
```bash
bun scripts/startup-recovery.ts [--force] [--timeout=30000]
```

### 3. Improved Middleware (`src/middleware.ts`)

The middleware now serves as a fallback recovery mechanism:

#### Changes:
- **Checks if recovery is needed** before attempting
- **Shorter timeout** (15 seconds) for request-time recovery
- **Better error handling** with status logging
- **Prevents multiple attempts** with proper state tracking

### 4. Enhanced Database Queries (`src/lib/helpers.ts`)

#### Improvements:
- **Proper Drizzle ORM syntax** for all database queries
- **Enhanced interrupted job detection** with multiple criteria (see `src/lib/interrupted-job-detection.ts`):
  - Jobs with no recent checkpoint (10+ minutes)
  - Jobs that never wrote a checkpoint and started 10+ minutes ago (a job that just started is live, not interrupted)
  - Jobs running too long (2+ hours)
- **Heartbeat during processing**: in-progress jobs start with a checkpoint and refresh it every 2 minutes, so one long item cannot make a live job look interrupted
- **Detailed logging** of found interrupted jobs
- **Better error handling** for database operations

### 5. Docker Integration (`docker-entrypoint.sh`)

#### Changes:
- **Automatic startup recovery** runs before application start
- **Exit code handling** with appropriate logging
- **Fallback mechanisms** if recovery script is not found
- **Non-blocking execution** - application starts even if recovery fails

### 6. Health Check Integration (`src/pages/api/health.ts`)

#### New Features:
- **Recovery system status** in health endpoint
- **Job recovery metrics** (jobs needing recovery, recovery in progress)
- **Overall health status** considers recovery state
- **Detailed recovery information** for monitoring

### 7. Testing Infrastructure (`scripts/test-recovery.ts`)

A comprehensive test script to verify recovery functionality:

#### Features:
- **Creates test interrupted jobs** with realistic scenarios
- **Verifies recovery detection** and execution
- **Checks final job states** after recovery
- **Cleanup functionality** for test data
- **Comprehensive logging** of test progress

## Configuration Options

### Recovery System Options:
- `maxRetries`: Number of recovery attempts (default: 3)
- `retryDelay`: Delay between attempts in ms (default: 5000)
- `skipIfRecentAttempt`: Skip if recent attempt made (default: true)

### Startup Recovery Options:
- `--force`: Force recovery even if recent attempt was made
- `--timeout`: Maximum time to wait for recovery (default: 30000ms)

## Usage Examples

### Manual Recovery:
```bash
# Run startup recovery
bun run startup-recovery

# Force recovery
bun run startup-recovery-force

# Test recovery system
bun run test-recovery

# Clean up test data
bun run test-recovery-cleanup
```

### Programmatic Usage:
```typescript
import { initializeRecovery, hasJobsNeedingRecovery } from '@/lib/recovery';

// Check if recovery is needed
const needsRecovery = await hasJobsNeedingRecovery();

// Run recovery with custom options
const success = await initializeRecovery({
  maxRetries: 5,
  retryDelay: 3000,
  skipIfRecentAttempt: false
});
```

## Monitoring and Observability

### Health Check Endpoint:
- **URL**: `/api/health`
- **Recovery Status**: Included in response
- **Monitoring**: Can be used with external monitoring systems

### Log Messages:
- **Startup**: Clear indicators of recovery attempts and results
- **Progress**: Detailed logging of recovery steps
- **Errors**: Comprehensive error information for debugging

## Benefits

1. **Reliability**: Jobs are automatically recovered after application restarts
2. **Resilience**: Multiple retry mechanisms and fallback strategies
3. **Observability**: Comprehensive logging and health check integration
4. **Performance**: Efficient detection and processing of interrupted jobs
5. **Maintainability**: Clear separation of concerns and modular design
6. **Testing**: Built-in testing infrastructure for verification

## Migration Notes

- **Backward Compatible**: All existing functionality is preserved
- **Automatic**: Recovery runs automatically on startup
- **Configurable**: All timeouts and retry counts can be adjusted
- **Monitoring**: Health checks now include recovery status

This comprehensive improvement ensures that the gitea-mirror application can reliably handle job recovery in all deployment scenarios, from development to production container environments.
