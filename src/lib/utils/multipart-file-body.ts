/**
 * A multipart/form-data body that streams one file from disk (#523).
 *
 * Bun's FormData reads a file part into memory to build the body, also a part
 * made with Bun.file, so uploading a release asset that way held all of it at
 * once. A Blob made of strings and a Bun.file is no way out: Bun sent only the
 * strings. This builds the part by hand and reads the file as the request goes
 * out, so an upload holds about one chunk whatever the file's size. The body is
 * sent chunked; a Content-Length set by hand next to a stream body came out
 * wrong in Bun.
 *
 * The file is read through a handle opened here, and the caller closes it with
 * `close()` once the request is over, however it ended (#539). When the server
 * answers before it has read the whole body (a 413 from a proxy's size limit,
 * an auth error), Bun stops reading the request body and never cancels it. The
 * Bun.file stream used before stayed open for the life of the process, so
 * removing the file afterwards freed no disk space.
 */
import { open } from "node:fs/promises";

/** How much of the file one read takes. */
const CHUNK_BYTES = 256 * 1024;

export interface MultipartFileBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  /** Closes the file. Safe to call more than once. */
  close: () => Promise<void>;
}

/** How browsers escape a name in Content-Disposition (the HTML form encoding). */
function escapeQuoted(value: string): string {
  return value.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export async function multipartFileBody(
  filePath: string,
  { field, fileName }: { field: string; fileName: string }
): Promise<MultipartFileBody> {
  const boundary = `----gitea-mirror-${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeQuoted(field)}"; filename="${escapeQuoted(fileName)}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const file = await open(filePath, "r");
  let reading: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  // The close waits for a read in progress: in Bun (1.3.14) a FileHandle
  // closed during a read reports success and keeps its descriptor for good.
  // That happens when a dropped connection cancels the body mid-read.
  const close = () =>
    (closing ??= (async () => {
      await reading?.catch(() => {});
      await file.close().catch(() => {});
    })());
  const closedError = () => new Error("The upload's file was closed before the body was sent");

  let sentHead = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!sentHead) {
          sentHead = true;
          controller.enqueue(head);
          return;
        }
        if (closing) throw closedError();
        const chunk = new Uint8Array(CHUNK_BYTES);
        const read = file.read(chunk, 0, CHUNK_BYTES, null);
        reading = read;
        const { bytesRead } = await read;
        if (closing) throw closedError();
        if (bytesRead > 0) {
          controller.enqueue(bytesRead === CHUNK_BYTES ? chunk : chunk.subarray(0, bytesRead));
          return;
        }
        await close();
        controller.enqueue(tail);
        controller.close();
      },
      async cancel() {
        await close();
      },
    },
    // Read the file only as fast as the request sends it.
    { highWaterMark: 0 }
  );

  return { body, contentType: `multipart/form-data; boundary=${boundary}`, close };
}
