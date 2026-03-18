import type { RepoStatus } from "@/types/Repository";
import { db, mirrorJobs } from "./db";
import { eq, and, or, lt, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { publishEvent } from "./events";
import { triggerJobNotification } from "./notification-service";

export async function createMirrorJob({
  userId,
  organizationId,
  organizationName,
  repositoryId,
  repositoryName,
  message,
  status,
  details,
  jobType,
  batchId,
  totalItems,
  itemIds,
  inProgress,
  skipDuplicateEvent,
  skipNotification,
}: {
  userId: string;
  organizationId?: string;
  organizationName?: string;
  repositoryId?: string;
  repositoryName?: string;
  details?: string;
  message: string;
  status: RepoStatus;
  jobType?: "mirror" | "sync" | "retry";
  batchId?: string;
  totalItems?: number;
  itemIds?: string[];
  inProgress?: boolean;
  skipDuplicateEvent?: boolean; // Option to skip event publishing for internal operations
  skipNotification?: boolean; // Option to skip push notifications for specific internal operations
}) {
  const jobId = uuidv4();
  const currentTimestamp = new Date();

  const job = {
    id: jobId,
    userId,
    repositoryId,
    repositoryName,
    organizationId,
    organizationName,
    details,
    message: message,
    status: status,
    timestamp: currentTimestamp,

    // New resilience fields
    jobType: jobType || "mirror",
    batchId: batchId || undefined,
    totalItems: totalItems || undefined,
    completedItems: 0,
    itemIds: itemIds || undefined,
    completedItemIds: [],
    inProgress: inProgress !== undefined ? inProgress : false,
    startedAt: inProgress ? currentTimestamp : undefined,
    completedAt: undefined,
    lastCheckpoint: undefined,
  };

  try {
    // Insert the job into the database
    await db.insert(mirrorJobs).values(job);

    // Publish realtime status events unless explicitly skipped
    if (!skipDuplicateEvent) {
      const channel = `mirror-status:${userId}`;

      // Create deduplication key based on the operation
      let deduplicationKey: string | undefined;
      if (repositoryId && status) {
        deduplicationKey = `repo-${repositoryId}-${status}`;
      } else if (organizationId && status) {
        deduplicationKey = `org-${organizationId}-${status}`;
      } else if (batchId) {
        deduplicationKey = `batch-${batchId}-${status}`;
      }

      await publishEvent({
        userId,
        channel,
        payload: job,
        deduplicationKey
      });
    }

    // Trigger push notifications for terminal statuses (never blocks the mirror flow).
    // Keep this independent from skipDuplicateEvent so event-stream suppression does not
    // silently disable user-facing notifications.
    if (!skipNotification && (status === "failed" || status === "mirrored" || status === "synced")) {
      triggerJobNotification({ userId, status, repositoryName, organizationName, message, details }).catch(err => {
        console.error("[NotificationService] Background notification failed:", err);
      });
    }

    return jobId;
  } catch (error) {
    console.error("Error creating mirror job:", error);
    throw new Error("Error creating mirror job");
  }
}

/**
 * Updates the progress of a mirror job
 */
export async function updateMirrorJobProgress({
  jobId,
  completedItemId,
  status,
  message,
  details,
  inProgress,
  isCompleted,
}: {
  jobId: string;
  completedItemId?: string;
  status?: RepoStatus;
  message?: string;
  details?: string;
  inProgress?: boolean;
  isCompleted?: boolean;
}) {
  try {
    // Get the current job
    const [job] = await db
      .select()
      .from(mirrorJobs)
      .where(eq(mirrorJobs.id, jobId));

    if (!job) {
      throw new Error(`Mirror job with ID ${jobId} not found`);
    }

    // Update the job with new progress
    const updates: Record<string, any> = {
      lastCheckpoint: new Date(),
    };

    // Add completed item if provided
    if (completedItemId) {
      const completedItemIds = job.completedItemIds || [];
      if (!completedItemIds.includes(completedItemId)) {
        updates.completedItemIds = [...completedItemIds, completedItemId];
        updates.completedItems = (job.completedItems || 0) + 1;
      }
    }

    // Update status if provided
    if (status) {
      updates.status = status;
    }

    // Update message if provided
    if (message) {
      updates.message = message;
    }

    // Update details if provided
    if (details) {
      updates.details = details;
    }

    // Update in-progress status if provided
    if (inProgress !== undefined) {
      updates.inProgress = inProgress;
    }

    // Mark as completed if specified
    if (isCompleted) {
      updates.inProgress = false;
      updates.completedAt = new Date();
    }

    // Update the job in the database
    await db
      .update(mirrorJobs)
      .set(updates)
      .where(eq(mirrorJobs.id, jobId));

    // Publish the event with deduplication
    const updatedJob = {
      ...job,
      ...updates,
    };

    // Create deduplication key for progress updates
    let deduplicationKey: string | undefined;
    if (completedItemId) {
      deduplicationKey = `progress-${jobId}-${completedItemId}`;
    } else if (isCompleted) {
      deduplicationKey = `completed-${jobId}`;
    } else {
      deduplicationKey = `update-${jobId}-${Date.now()}`;
    }

    await publishEvent({
      userId: job.userId,
      channel: `mirror-status:${job.userId}`,
      payload: updatedJob,
      deduplicationKey
    });

    return updatedJob;
  } catch (error) {
    console.error("Error updating mirror job progress:", error);
    throw new Error("Error updating mirror job progress");
  }
}

/**
 * Finds interrupted jobs that need to be resumed with enhanced criteria
 */
export async function findInterruptedJobs() {
  try {
    // Find jobs that are marked as in-progress but haven't been updated recently
    const cutoffTime = new Date();
    cutoffTime.setMinutes(cutoffTime.getMinutes() - 10); // Consider jobs inactive after 10 minutes without updates

    // Also check for jobs that have been running for too long (over 2 hours)
    const staleCutoffTime = new Date();
    staleCutoffTime.setHours(staleCutoffTime.getHours() - 2);

    const interruptedJobs = await db
      .select()
      .from(mirrorJobs)
      .where(
        and(
          eq(mirrorJobs.inProgress, true),
          or(
            // Jobs with no recent checkpoint
            or(isNull(mirrorJobs.lastCheckpoint), lt(mirrorJobs.lastCheckpoint, cutoffTime)),
            // Jobs that started too long ago (likely stale)
            lt(mirrorJobs.startedAt, staleCutoffTime)
          )
        )
      );

    // Log details about found jobs for debugging
    if (interruptedJobs.length > 0) {
      console.log(`Found ${interruptedJobs.length} interrupted jobs:`);
      interruptedJobs.forEach(job => {
        const lastCheckpoint = job.lastCheckpoint ? new Date(job.lastCheckpoint).toISOString() : 'never';
        const startedAt = job.startedAt ? new Date(job.startedAt).toISOString() : 'unknown';
        console.log(`- Job ${job.id}: ${job.jobType} (started: ${startedAt}, last checkpoint: ${lastCheckpoint})`);
      });
    }

    return interruptedJobs;
  } catch (error) {
    console.error("Error finding interrupted jobs:", error);
    return [];
  }
}

/**
 * Resumes an interrupted job
 */
export async function resumeInterruptedJob(job: any) {
  try {
    console.log(`Resuming interrupted job: ${job.id}`);

    // Skip if job doesn't have the necessary data to resume
    if (!job.itemIds || !job.completedItemIds) {
      console.log(`Cannot resume job ${job.id}: missing item data`);

      // Mark the job as failed
      await updateMirrorJobProgress({
        jobId: job.id,
        status: "failed",
        message: "Job interrupted and could not be resumed",
        details: "The job was interrupted and did not have enough information to resume",
        inProgress: false,
        isCompleted: true,
      });

      return null;
    }

    // Calculate remaining items
    const remainingItemIds = job.itemIds.filter(
      (id: string) => !job.completedItemIds.includes(id)
    );

    if (remainingItemIds.length === 0) {
      console.log(`Job ${job.id} has no remaining items, marking as completed`);

      // Mark the job as completed
      await updateMirrorJobProgress({
        jobId: job.id,
        status: "mirrored",
        message: "Job completed after resuming",
        inProgress: false,
        isCompleted: true,
      });

      return null;
    }

    // Update the job to show it's being resumed
    await updateMirrorJobProgress({
      jobId: job.id,
      message: `Resuming job with ${remainingItemIds.length} remaining items`,
      details: `Job was interrupted and is being resumed. ${job.completedItemIds.length} of ${job.itemIds.length} items were already processed.`,
      inProgress: true,
    });

    return {
      job,
      remainingItemIds,
    };
  } catch (error) {
    console.error(`Error resuming job ${job.id}:`, error);
    return null;
  }
}
