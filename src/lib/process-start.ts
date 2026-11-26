/**
 * When this process started. With SQLite there is one app process, so a row
 * marked as in flight and last touched before this moment was left by a
 * process that is gone: nothing is working on it any more.
 *
 * Taken from performance.timeOrigin, the start of the process, not from when
 * a module happened to load. A dev server reloads modules in the same
 * process, and work started before the reload is still running.
 */
const PROCESS_START = new Date(performance.timeOrigin);

export function getProcessStart(): Date {
  return PROCESS_START;
}
