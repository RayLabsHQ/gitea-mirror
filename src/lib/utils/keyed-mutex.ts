/**
 * Per-key async mutex (issue #417).
 *
 * Release asset reconciliation is a read-then-write against the destination:
 * list the attachments a release already has, then upload whatever is missing.
 * The destination has no name-collision check on attachment upload (Gitea's and
 * Forgejo's CreateReleaseAttachment appends a row for every POST), so two
 * passes that overlap on the same release both see an asset as absent and both
 * upload it. N overlapping passes leave N copies of every asset.
 *
 * A per-row status guard cannot close that window on its own: two repository
 * rows (the same upstream repository imported under two sources, say) resolve
 * to the same destination repository, so the exclusion has to be keyed on the
 * destination rather than on the database row.
 *
 * This lock is process-local, which is where the overlapping passes seen in
 * #417 come from: the scheduler racing a manual run, recovery resuming a job
 * that is still running, or duplicate repository rows processed together by one
 * Promise.all.
 */

/**
 * Tail of the queue for each key. It settles (and never rejects) once the last
 * queued caller is done, so the next caller only has to wait on it.
 */
const queues = new Map<string, Promise<void>>();

/**
 * Run `fn` with exclusive access to `key`. Callers on the same key run one at a
 * time in the order they arrived; callers on different keys are unaffected.
 * The lock is released whether `fn` resolves or throws, and the caller still
 * sees `fn`'s own result or error.
 */
export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();

  // `previous` never rejects, so a caller that threw still hands the key on.
  const result = previous.then(() => fn());

  // The tail swallows the outcome: the next caller only needs to know the
  // previous one finished, and an unobserved rejection here would surface as
  // an unhandled rejection.
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  queues.set(key, tail);

  // Drop the key once nobody is queued behind this caller, so the map does not
  // grow one permanent entry per repository.
  void tail.then(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });

  return result;
}

/** Number of keys currently held or queued. For tests and diagnostics. */
export function keyedLockCount(): number {
  return queues.size;
}
