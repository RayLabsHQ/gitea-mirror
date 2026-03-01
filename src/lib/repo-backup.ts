import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "@/types/config";
import { decryptConfigTokens } from "./utils/config-encryption";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function sanitizePathSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildTimestamp(): string {
  // Example: 2026-02-25T18-34-22-123Z
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildAuthenticatedCloneUrl(cloneUrl: string, token: string): string {
  const parsed = new URL(cloneUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return cloneUrl;
  }

  parsed.username = process.env.PRE_SYNC_BACKUP_GIT_USERNAME || "oauth2";
  parsed.password = token;
  return parsed.toString();
}

function maskToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("***");
}

async function runGit(args: string[], tokenToMask: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = [stdout, stderr].filter(Boolean).join("\n").trim();
    const safeDetails = maskToken(details, tokenToMask);
    throw new Error(`git command failed: ${safeDetails || "unknown git error"}`);
  }
}

async function enforceRetention(repoBackupDir: string, keepCount: number): Promise<void> {
  const entries = await readdir(repoBackupDir);
  const bundleFiles = entries
    .filter((name) => name.endsWith(".bundle"))
    .map((name) => path.join(repoBackupDir, name));

  if (bundleFiles.length <= keepCount) return;

  const filesWithMtime = await Promise.all(
    bundleFiles.map(async (filePath) => ({
      filePath,
      mtimeMs: (await stat(filePath)).mtimeMs,
    }))
  );

  filesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = filesWithMtime.slice(keepCount);

  await Promise.all(toDelete.map((entry) => rm(entry.filePath, { force: true })));
}

export function isPreSyncBackupEnabled(): boolean {
  return parseBoolean(process.env.PRE_SYNC_BACKUP_ENABLED, true);
}

export function shouldCreatePreSyncBackup(config: Partial<Config>): boolean {
  const configSetting = config.giteaConfig?.backupBeforeSync;
  const fallback = isPreSyncBackupEnabled();
  return configSetting === undefined ? fallback : Boolean(configSetting);
}

export function shouldBlockSyncOnBackupFailure(config: Partial<Config>): boolean {
  const configSetting = config.giteaConfig?.blockSyncOnBackupFailure;
  return configSetting === undefined ? true : Boolean(configSetting);
}

export function resolveBackupPaths({
  config,
  owner,
  repoName,
}: {
  config: Partial<Config>;
  owner: string;
  repoName: string;
}): { backupRoot: string; repoBackupDir: string } {
  let backupRoot =
    config.giteaConfig?.backupDirectory?.trim() ||
    process.env.PRE_SYNC_BACKUP_DIR?.trim() ||
    path.join(process.cwd(), "data", "repo-backups");

  // Ensure backupRoot is absolute - relative paths break git bundle creation
  // because git runs with -C mirrorClonePath and interprets relative paths from there.
  // Always use path.resolve() which guarantees an absolute path, rather than a
  // conditional check that can miss edge cases (e.g., NixOS systemd services).
  backupRoot = path.resolve(backupRoot);

  const repoBackupDir = path.join(
    backupRoot,
    sanitizePathSegment(config.userId || "unknown-user"),
    sanitizePathSegment(owner),
    sanitizePathSegment(repoName)
  );

  return { backupRoot, repoBackupDir };
}

export async function createPreSyncBundleBackup({
  config,
  owner,
  repoName,
  cloneUrl,
}: {
  config: Partial<Config>;
  owner: string;
  repoName: string;
  cloneUrl: string;
}): Promise<{ bundlePath: string }> {
  if (!shouldCreatePreSyncBackup(config)) {
    throw new Error("Pre-sync backup is disabled.");
  }

  if (!config.giteaConfig?.token) {
    throw new Error("Gitea token is required for pre-sync backup.");
  }

  const decryptedConfig = decryptConfigTokens(config as Config);
  const giteaToken = decryptedConfig.giteaConfig?.token;
  if (!giteaToken) {
    throw new Error("Decrypted Gitea token is required for pre-sync backup.");
  }

  const { repoBackupDir } = resolveBackupPaths({ config, owner, repoName });
  const retention = Math.max(
    1,
    Number.isFinite(config.giteaConfig?.backupRetentionCount)
      ? Number(config.giteaConfig?.backupRetentionCount)
      : parsePositiveInt(process.env.PRE_SYNC_BACKUP_KEEP_COUNT, 20)
  );

  await mkdir(repoBackupDir, { recursive: true });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gitea-mirror-backup-"));
  const mirrorClonePath = path.join(tmpDir, "repo.git");
  // path.resolve guarantees an absolute path, critical because git -C changes
  // the working directory and would misinterpret a relative bundlePath
  const bundlePath = path.resolve(repoBackupDir, `${buildTimestamp()}.bundle`);

  try {
    const authCloneUrl = buildAuthenticatedCloneUrl(cloneUrl, giteaToken);

    await runGit(["clone", "--mirror", authCloneUrl, mirrorClonePath], giteaToken);
    await runGit(["-C", mirrorClonePath, "bundle", "create", bundlePath, "--all"], giteaToken);

    await enforceRetention(repoBackupDir, retention);
    return { bundlePath };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
