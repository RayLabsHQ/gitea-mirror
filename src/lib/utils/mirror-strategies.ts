/**
 * Mirror strategy configuration for handling various repository scenarios
 */

export type NonMirrorStrategy = "skip" | "delete" | "rename" | "convert";

export interface MirrorStrategyConfig {
  /**
   * How to handle repositories that exist in Gitea but are not mirrors
   * - "skip": Leave the repository as-is and mark as failed
   * - "delete": Delete the repository and recreate as mirror
   * - "rename": Rename the existing repository (not implemented yet)
   * - "convert": Try to convert to mirror (not supported by most Gitea versions)
   */
  nonMirrorStrategy: NonMirrorStrategy;

  /**
   * Maximum retries for organization creation
   */
  orgCreationRetries: number;

  /**
   * Base delay in milliseconds for exponential backoff
   */
  orgCreationRetryDelay: number;

  /**
   * Whether to create organizations sequentially to avoid race conditions
   */
  sequentialOrgCreation: boolean;

  /**
   * Batch size for parallel repository processing
   */
  repoBatchSize: number;

  /**
   * Timeout for sync operations in milliseconds
   */
  syncTimeout: number;
}

export const DEFAULT_MIRROR_STRATEGY: MirrorStrategyConfig = {
  nonMirrorStrategy: "delete", // Safe default: delete and recreate
  orgCreationRetries: 3,
  orgCreationRetryDelay: 100,
  sequentialOrgCreation: true,
  repoBatchSize: 3,
  syncTimeout: 30000, // 30 seconds
};

/**
 * Get mirror strategy configuration from environment or defaults
 */
export function getMirrorStrategyConfig(): MirrorStrategyConfig {
  return {
    nonMirrorStrategy: (process.env.NON_MIRROR_STRATEGY as NonMirrorStrategy) || DEFAULT_MIRROR_STRATEGY.nonMirrorStrategy,
    orgCreationRetries: parseInt(process.env.ORG_CREATION_RETRIES || "") || DEFAULT_MIRROR_STRATEGY.orgCreationRetries,
    orgCreationRetryDelay: parseInt(process.env.ORG_CREATION_RETRY_DELAY || "") || DEFAULT_MIRROR_STRATEGY.orgCreationRetryDelay,
    sequentialOrgCreation: process.env.SEQUENTIAL_ORG_CREATION !== "false",
    repoBatchSize: parseInt(process.env.REPO_BATCH_SIZE || "") || DEFAULT_MIRROR_STRATEGY.repoBatchSize,
    syncTimeout: parseInt(process.env.SYNC_TIMEOUT || "") || DEFAULT_MIRROR_STRATEGY.syncTimeout,
  };
}

/**
 * Validate strategy configuration
 */
export function validateStrategyConfig(config: MirrorStrategyConfig): string[] {
  const errors: string[] = [];

  if (!["skip", "delete", "rename", "convert"].includes(config.nonMirrorStrategy)) {
    errors.push(`Invalid nonMirrorStrategy: ${config.nonMirrorStrategy}`);
  }

  if (config.orgCreationRetries < 1 || config.orgCreationRetries > 10) {
    errors.push("orgCreationRetries must be between 1 and 10");
  }

  if (config.orgCreationRetryDelay < 10 || config.orgCreationRetryDelay > 5000) {
    errors.push("orgCreationRetryDelay must be between 10ms and 5000ms");
  }

  if (config.repoBatchSize < 1 || config.repoBatchSize > 50) {
    errors.push("repoBatchSize must be between 1 and 50");
  }

  if (config.syncTimeout < 5000 || config.syncTimeout > 300000) {
    errors.push("syncTimeout must be between 5s and 5min");
  }

  return errors;
}