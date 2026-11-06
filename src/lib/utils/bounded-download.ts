/**
 * Downloads held to limits, for files fetched from hosts we do not run.
 *
 * Bun keeps reading a response after its body is cancelled, and holds what it
 * reads, so a server that never stops sending grows memory until the process
 * dies. Only aborting the request closes the connection. Every way out of a
 * download here aborts its request: an error status, a limit, an exception,
 * and the normal end, where the abort changes nothing.
 */

export class DownloadLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadLimitError";
  }
}

export interface DownloadLimits {
  /** Give up when nothing arrives for this long, the response headers included. */
  stallTimeoutMs: number;
  /** Refuse a body larger than this many bytes. */
  maxBytes?: number;
  /** Give up when the whole download takes longer than this. */
  totalTimeoutMs?: number;
}

export type BoundedDownload =
  | { ok: true; status: number; data: Blob }
  | { ok: false; status: number; statusText: string };

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${Math.round(mib)} MB` : `${bytes} bytes`;
}

function formatDuration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/**
 * Runs `start` with a signal to hand to fetch, then reads the body under the
 * limits. An error status comes back as `ok: false` with its body unread and its
 * request aborted; a limit throws DownloadLimitError.
 */
export async function downloadWithLimits(
  start: (signal: AbortSignal) => Promise<Response>,
  limits: DownloadLimits
): Promise<BoundedDownload> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let limitError: DownloadLimitError | undefined;
  const stop = (message: string) => {
    if (limitError) return;
    limitError = new DownloadLimitError(message);
    controller.abort(limitError);
    // The abort errors a fetch body; cancelling also ends a read on a body
    // that does not listen to the signal.
    reader?.cancel(limitError).catch(() => {});
  };

  // One watchdog for both clocks instead of a timer per chunk. It may notice a
  // limit up to a quarter of the shorter one late.
  const { stallTimeoutMs, totalTimeoutMs } = limits;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (totalTimeoutMs !== undefined && now - startedAt >= totalTimeoutMs) {
      stop(`The download took longer than ${formatDuration(totalTimeoutMs)}`);
    } else if (now - lastActivityAt >= stallTimeoutMs) {
      stop(`No data for ${formatDuration(stallTimeoutMs)}`);
    }
  }, Math.max(5, Math.min(stallTimeoutMs, totalTimeoutMs ?? Infinity) / 4));
  const tooLarge = (maxBytes: number) => new DownloadLimitError(`Larger than ${formatBytes(maxBytes)}`);

  try {
    const response = await start(controller.signal);
    lastActivityAt = Date.now();
    if (!response.ok) {
      return { ok: false, status: response.status, statusText: response.statusText };
    }

    const { maxBytes } = limits;
    const declared = Number(response.headers.get("content-length"));
    if (maxBytes !== undefined && declared > maxBytes) {
      throw tooLarge(maxBytes);
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastActivityAt = Date.now();
        received += value.byteLength;
        if (maxBytes !== undefined && received > maxBytes) {
          throw tooLarge(maxBytes);
        }
        chunks.push(value);
      }
    }
    if (limitError) throw limitError;
    return { ok: true, status: response.status, data: new Blob(chunks as BlobPart[]) };
  } catch (error) {
    // A limit aborts the request, and fetch or the read then fails with the
    // abort; report the limit, not the abort.
    throw limitError ?? error;
  } finally {
    clearInterval(watchdog);
    controller.abort();
  }
}
