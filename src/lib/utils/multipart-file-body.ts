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
 */

/** How browsers escape a name in Content-Disposition (the HTML form encoding). */
function escapeQuoted(value: string): string {
  return value.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function multipartFileBody(
  filePath: string,
  { field, fileName }: { field: string; fileName: string }
): { body: ReadableStream<Uint8Array>; contentType: string } {
  const boundary = `----gitea-mirror-${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeQuoted(field)}"; filename="${escapeQuoted(fileName)}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!reader) {
          reader = Bun.file(filePath).stream().getReader();
          controller.enqueue(head);
          return;
        }
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        controller.enqueue(tail);
        controller.close();
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    },
    // Read the file only as fast as the request sends it.
    { highWaterMark: 0 }
  );

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
