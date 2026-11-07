import type { BackupStrategy } from "@/types/config";

/**
 * Backup settings from the PRE_SYNC_BACKUP_* variables.
 *
 * They seed a new configuration's backup fields, so the variables decide the
 * starting values; once a value is stored it wins over the environment
 * (#503). Kept apart from repo-backup.ts, which tests replace with
 * mock.module, so the config code that imports this always gets the real one.
 */

const BACKUP_STRATEGIES = new Set<string>([
  "disabled",
  "always",
  "on-force-push",
  "block-on-force-push",
]);

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isBackupStrategy(value: unknown): value is BackupStrategy {
  return typeof value === "string" && BACKUP_STRATEGIES.has(value);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The strategy a stored configuration asks for: its backupStrategy, or else the
 * deprecated backupBeforeSync. That maps true to "on-force-push", not
 * "always", because mappers default it to true and "always" made every legacy
 * config bundle on every sync. Undefined when neither is stored.
 */
export function storedBackupStrategy(
  giteaConfig: { backupStrategy?: unknown; backupBeforeSync?: unknown } | null | undefined
): BackupStrategy | undefined {
  if (isBackupStrategy(giteaConfig?.backupStrategy)) {
    return giteaConfig.backupStrategy;
  }
  const legacy = giteaConfig?.backupBeforeSync;
  if (legacy !== undefined) {
    return legacy ? "on-force-push" : "disabled";
  }
  return undefined;
}

/**
 * PRE_SYNC_BACKUP_STRATEGY, then the legacy PRE_SYNC_BACKUP_ENABLED, where any
 * true value means "always". Undefined when neither is set to something usable.
 */
export function backupStrategyFromEnv(): BackupStrategy | undefined {
  const strategy = process.env.PRE_SYNC_BACKUP_STRATEGY?.trim().toLowerCase();
  if (isBackupStrategy(strategy)) {
    return strategy;
  }
  const enabled = process.env.PRE_SYNC_BACKUP_ENABLED;
  if (enabled !== undefined) {
    return TRUE_VALUES.has(enabled.trim().toLowerCase()) ? "always" : "disabled";
  }
  return undefined;
}

export interface BackupDefaults {
  backupStrategy: BackupStrategy;
  /** Deprecated field, kept in step with the strategy for older readers. */
  backupBeforeSync: boolean;
  backupRetentionCount: number;
  backupRetentionDays: number;
  /** Undefined when PRE_SYNC_BACKUP_DIR is not set. */
  backupDirectory?: string;
}

/** The backup fields a configuration starts with. */
export function backupDefaultsFromEnv(): BackupDefaults {
  const backupStrategy = backupStrategyFromEnv() ?? "on-force-push";
  return {
    backupStrategy,
    backupBeforeSync: backupStrategy !== "disabled",
    backupRetentionCount: positiveInt(process.env.PRE_SYNC_BACKUP_KEEP_COUNT, 5),
    backupRetentionDays: positiveInt(process.env.PRE_SYNC_BACKUP_RETENTION_DAYS, 30),
    backupDirectory: process.env.PRE_SYNC_BACKUP_DIR?.trim() || undefined,
  };
}
