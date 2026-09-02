import { JOB_HEARTBEAT_INTERVAL_MS } from "@/lib/interrupted-job-detection";

/**
 * Utility for processing items in parallel with concurrency control
 *
 * @param items Array of items to process
 * @param processItem Function to process each item
 * @param concurrencyLimit Maximum number of concurrent operations
 * @param onProgress Optional callback for progress updates
 * @returns Promise that resolves when all items are processed
 */
export async function processInParallel<T, R>(
  items: T[],
  processItem: (item: T) => Promise<R>,
  concurrencyLimit: number = 5, // Safe default for GitHub API (max 100 concurrent, but 5-10 recommended)
  onProgress?: (completed: number, total: number, result?: R) => void
): Promise<R[]> {
  const results: R[] = [];
  let completed = 0;
  const total = items.length;

  // Process items in batches to control concurrency
  for (let i = 0; i < total; i += concurrencyLimit) {
    const batch = items.slice(i, i + concurrencyLimit);

    const batchPromises = batch.map(async (item) => {
      try {
        const result = await processItem(item);
        completed++;

        if (onProgress) {
          onProgress(completed, total, result);
        }

        return result;
      } catch (error) {
        completed++;

        if (onProgress) {
          onProgress(completed, total);
        }

        throw error;
      }
    });

    // Wait for the current batch to complete before starting the next batch
    const batchResults = await Promise.allSettled(batchPromises);

    // Process results and handle errors
    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const itemIndex = i + j;
        console.error("=== BATCH ITEM PROCESSING ERROR ===");
        console.error("Batch index:", Math.floor(i / concurrencyLimit));
        console.error("Item index in batch:", j);
        console.error("Global item index:", itemIndex);
        console.error("Error type:", result.reason?.constructor?.name);
        console.error("Error message:", result.reason instanceof Error ? result.reason.message : String(result.reason));

        if (result.reason instanceof Error && result.reason.message.includes('JSON')) {
          console.error("🚨 JSON parsing error in batch processing");
          console.error("This indicates an API response issue from Gitea");
        }

        console.error("==================================");
      }
    }
  }

  return results;
}

/**
 * Utility for processing items in parallel with automatic retry for failed operations
 *
 * @param items Array of items to process
 * @param processItem Function to process each item
 * @param options Configuration options
 * @returns Promise that resolves when all items are processed
 */
export async function processWithRetry<T, R>(
  items: T[],
  processItem: (item: T) => Promise<R>,
  options: {
    concurrencyLimit?: number;
    maxRetries?: number;
    retryDelay?: number;
    onProgress?: (completed: number, total: number, result?: R) => void;
    onRetry?: (item: T, error: Error, attempt: number) => void;
    jobId?: string; // Optional job ID for checkpointing
    getItemId?: (item: T) => string; // Function to get a unique ID for each item
    onCheckpoint?: (jobId: string, completedItemId: string) => Promise<void>; // Callback for checkpointing
    checkpointInterval?: number; // How many items to process before checkpointing
  } = {}
): Promise<R[]> {
  const {
    concurrencyLimit = 5,
    maxRetries = 3,
    retryDelay = 1000,
    onProgress,
    onRetry,
    jobId,
    getItemId,
    onCheckpoint,
    checkpointInterval = 1 // Default to checkpointing after each item
  } = options;

  // Track checkpoint counter
  let itemsProcessedSinceLastCheckpoint = 0;

  // Wrap the process function with retry logic
  const processWithRetryLogic = async (item: T): Promise<R> => {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        // Check for shutdown before processing each item (only in production)
        try {
          const { isShuttingDown } = await import('@/lib/shutdown-manager');
          if (isShuttingDown()) {
            throw new Error('Processing interrupted by application shutdown');
          }
        } catch (importError) {
          // Ignore import errors during testing
        }

        const result = await processItem(item);

        // Handle checkpointing if enabled
        if (jobId && getItemId && onCheckpoint) {
          const itemId = getItemId(item);
          itemsProcessedSinceLastCheckpoint++;

          // Checkpoint based on the interval
          if (itemsProcessedSinceLastCheckpoint >= checkpointInterval) {
            await onCheckpoint(jobId, itemId);
            itemsProcessedSinceLastCheckpoint = 0;
          }
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt <= maxRetries) {
          if (onRetry) {
            onRetry(item, lastError, attempt);
          }

          // Exponential backoff
          const delay = retryDelay * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Enhanced error logging for final failure
          console.error("=== ITEM PROCESSING FAILED (MAX RETRIES EXCEEDED) ===");
          console.error("Item:", getItemId ? getItemId(item) : 'unknown');
          console.error("Error type:", lastError.constructor.name);
          console.error("Error message:", lastError.message);
          console.error("Attempts made:", maxRetries + 1);

          if (lastError.message.includes('JSON')) {
            console.error("🚨 JSON-related error detected in item processing");
            console.error("This suggests an issue with API responses from Gitea");
          }

          console.error("Stack trace:", lastError.stack);
          console.error("================================================");

          throw lastError;
        }
      }
    }

    // This should never be reached due to the throw in the catch block
    throw lastError || new Error('Unknown error occurred');
  };

  const results = await processInParallel(
    items,
    processWithRetryLogic,
    concurrencyLimit,
    onProgress
  );

  // Final checkpoint if there are remaining items since the last checkpoint
  if (jobId && getItemId && onCheckpoint && itemsProcessedSinceLastCheckpoint > 0) {
    // We don't have a specific item ID for the final checkpoint, so we'll use a placeholder
    await onCheckpoint(jobId, 'final');
  }

  return results;
}

/**
 * Process items in parallel with resilience to container restarts
 * This version supports resuming from a previous checkpoint
 */
export async function processWithResilience<T, R>(
  items: T[],
  processItem: (item: T) => Promise<R>,
  options: {
    concurrencyLimit?: number;
    maxRetries?: number;
    retryDelay?: number;
    onProgress?: (completed: number, total: number, result?: R) => void;
    onRetry?: (item: T, error: Error, attempt: number) => void;
    userId: string; // Required for creating mirror jobs
    jobType: "mirror" | "sync" | "retry";
    getItemId: (item: T) => string; // Required function to get a unique ID for each item
    getItemName: (item: T) => string; // Required function to get a display name for each item
    checkpointInterval?: number;
    resumeFromJobId?: string; // Optional job ID to resume from
  }
): Promise<R[]> {
  const {
    userId,
    jobType,
    getItemId,
    getItemName,
    resumeFromJobId,
    checkpointInterval = 10, // Increased from 5 to reduce event frequency
    ...otherOptions
  } = options;

  // Import helpers for job management and shutdown handling
  const { createMirrorJob, updateMirrorJobProgress, touchMirrorJobCheckpoint } = await import('@/lib/helpers');

  // Import shutdown manager (with fallback for testing)
  let registerActiveJob: (jobId: string) => void = () => {};
  let unregisterActiveJob: (jobId: string) => void = () => {};
  let isShuttingDown: () => boolean = () => false;

  try {
    const shutdownManager = await import('@/lib/shutdown-manager');
    registerActiveJob = shutdownManager.registerActiveJob;
    unregisterActiveJob = shutdownManager.unregisterActiveJob;
    isShuttingDown = shutdownManager.isShuttingDown;
  } catch (importError) {
    // Use fallback functions during testing
    console.log('Using fallback shutdown manager functions (testing mode)');
  }

  // Get item IDs for all items
  const allItemIds = items.map(getItemId);

  // Create or resume a job
  let jobId: string;
  let completedItemIds: string[] = [];
  let itemsToProcess = [...items];

  if (resumeFromJobId) {
    // We're resuming an existing job
    jobId = resumeFromJobId;

    // Get the job from the database to find completed items
    const { db, mirrorJobs } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const [job] = await db
      .select()
      .from(mirrorJobs)
      .where(eq(mirrorJobs.id, resumeFromJobId));

    if (job && job.completedItemIds) {
      completedItemIds = job.completedItemIds;

      // Filter out already completed items
      itemsToProcess = items.filter(item => !completedItemIds.includes(getItemId(item)));

      console.log(`Resuming job ${jobId} with ${itemsToProcess.length} remaining items`);

      // Update the job to show it's being resumed
      await updateMirrorJobProgress({
        jobId,
        message: `Resuming job with ${itemsToProcess.length} remaining items`,
        details: `Job is being resumed. ${completedItemIds.length} of ${items.length} items were already processed.`,
        inProgress: true,
      });
    }
  } else {
    // Create a new job
    jobId = await createMirrorJob({
      userId,
      message: `Started ${jobType} job with ${items.length} items`,
      details: `Processing ${items.length} items in parallel with checkpointing`,
      status: "mirroring",
      jobType,
      totalItems: items.length,
      itemIds: allItemIds,
      inProgress: true,
    });

    console.log(`Created new job ${jobId} with ${items.length} items`);
  }

  // Register the job with the shutdown manager
  registerActiveJob(jobId);

  // Heartbeat while items are processing. Checkpoints are only written when
  // an item completes, so a single long item would otherwise let the job
  // cross the interrupted-job cutoff and be "resumed" by recovery while it
  // is still running (issue #372).
  const heartbeat = setInterval(() => {
    touchMirrorJobCheckpoint(jobId).catch((error: unknown) => {
      console.warn(`Failed to refresh checkpoint for job ${jobId}:`, error);
    });
  }, JOB_HEARTBEAT_INTERVAL_MS);

  // Define the checkpoint function
  const onCheckpoint = async (jobId: string, completedItemId: string) => {
    const itemName = items.find(item => getItemId(item) === completedItemId)
      ? getItemName(items.find(item => getItemId(item) === completedItemId)!)
      : 'unknown';

    await updateMirrorJobProgress({
      jobId,
      completedItemId,
      message: `Processed item: ${itemName}`,
    });
  };

  try {
    // Check if shutdown is in progress before starting
    if (isShuttingDown()) {
      console.log(`⚠️  Shutdown in progress, aborting job ${jobId}`);
      throw new Error('Job aborted due to application shutdown');
    }

    // Process the items with checkpointing
    const results = await processWithRetry(
      itemsToProcess,
      processItem,
      {
        ...otherOptions,
        jobId,
        getItemId,
        onCheckpoint,
        checkpointInterval,
      }
    );

    // Mark the job as completed
    await updateMirrorJobProgress({
      jobId,
      status: "mirrored",
      message: `Completed ${jobType} job with ${items.length} items`,
      inProgress: false,
      isCompleted: true,
    });

    // Unregister the job from shutdown manager
    unregisterActiveJob(jobId);

    return results;
  } catch (error) {
    // Mark the job as failed (unless it was interrupted by shutdown)
    const isShutdownError = error instanceof Error && error.message.includes('shutdown');

    await updateMirrorJobProgress({
      jobId,
      status: isShutdownError ? "imported" : "failed", // Keep as imported if shutdown interrupted
      message: isShutdownError
        ? 'Job interrupted by application shutdown - will resume on restart'
        : `Failed ${jobType} job: ${error instanceof Error ? error.message : String(error)}`,
      inProgress: false,
      isCompleted: !isShutdownError, // Don't mark as completed if shutdown interrupted
    });

    // Unregister the job from shutdown manager
    unregisterActiveJob(jobId);

    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
