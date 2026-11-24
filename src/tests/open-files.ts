import { existsSync, readdirSync, readlinkSync } from "node:fs";

/**
 * How many file descriptors this process holds on paths under `prefix`,
 * removed files included. Linux answers from /proc; elsewhere lsof does, so on
 * macOS pass the real path (`fs.realpath`), since lsof prints /private/var for
 * the temp directory.
 */
export function openFileCount(prefix: string): number {
  if (existsSync("/proc/self/fd")) {
    let count = 0;
    for (const fd of readdirSync("/proc/self/fd")) {
      try {
        if (readlinkSync(`/proc/self/fd/${fd}`).startsWith(prefix)) count++;
      } catch {
        // The descriptor closed while we were looking.
      }
    }
    return count;
  }
  const lsof = Bun.spawnSync(["lsof", "-nP", "-p", String(process.pid)]);
  return lsof.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(prefix)).length;
}
