import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openFileCount } from "@/tests/open-files";
import { multipartFileBody, type MultipartFileBody } from "./multipart-file-body";

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "multipart-file-body-test-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Parses the body the way a server would. */
async function parse(upload: MultipartFileBody) {
  const request = new Request("http://destination.test/upload", {
    method: "POST",
    headers: { "content-type": upload.contentType },
    body: upload.body,
    duplex: "half",
  } as RequestInit);
  return request.formData();
}

/** A file big enough that a request cannot take it in one write. */
async function writeLargeFile(name: string): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, new Uint8Array(8 * 1024 * 1024).fill(97));
  return filePath;
}

describe("multipartFileBody", () => {
  it("carries the file under the field and name given", async () => {
    const filePath = path.join(dir, "asset");
    const bytes = new Uint8Array(3 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    await writeFile(filePath, bytes);

    const form = await parse(await multipartFileBody(filePath, { field: "attachment", fileName: "tool-1.0.tar.gz" }));

    const file = form.get("attachment") as File;
    expect(file.name).toBe("tool-1.0.tar.gz");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("keeps quotes and line breaks in a name from breaking the part", async () => {
    const filePath = path.join(dir, "asset");
    await writeFile(filePath, "body");

    const form = await parse(await multipartFileBody(filePath, { field: "attachment", fileName: 'a"b\r\nc.zip' }));

    expect([...form.keys()]).toEqual(["attachment"]);
    expect(await (form.get("attachment") as File).text()).toBe("body");
  });

  it("closes the file once the whole body has been read", async () => {
    const filePath = await writeLargeFile("asset");

    await parse(await multipartFileBody(filePath, { field: "attachment", fileName: "a.bin" }));

    expect(openFileCount(dir)).toBe(0);
  });

  // #539: a destination (or a proxy in front of it) that answers before
  // reading the upload, such as a 413 for a size limit. Bun then stops reading
  // the request body without cancelling it, so the file stayed open after it
  // was removed and its disk space was never freed.
  it("close() releases the file when the server answers before reading the body", async () => {
    // Answers without touching the request body.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 413 }),
    });

    try {
      const filePath = await writeLargeFile("asset");
      const upload = await multipartFileBody(filePath, { field: "attachment", fileName: "a.bin" });
      const response = await Bun.fetch(`http://127.0.0.1:${server.port}/upload`, {
        method: "POST",
        headers: { "Content-Type": upload.contentType },
        body: upload.body,
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(413);

      await upload.close();
      expect(openFileCount(dir)).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  // In Bun, closing a file handle while a read on it is still running reports
  // success and leaves the descriptor open. A dropped connection cancels the
  // body at any moment, so close() has to wait for the read.
  it("close() during a read still releases the file", async () => {
    const filePath = await writeLargeFile("asset");
    const upload = await multipartFileBody(filePath, { field: "attachment", fileName: "a.bin" });
    const reader = upload.body.getReader();
    await reader.read(); // the part header

    // Starts a read of the file, which then fails because the file closed.
    const reading = reader.read().catch(() => undefined);
    await upload.close();
    await reading;

    expect(openFileCount(dir)).toBe(0);
  });

  it("close() can be called again after the body ended", async () => {
    const filePath = path.join(dir, "asset");
    await writeFile(filePath, "body");
    const upload = await multipartFileBody(filePath, { field: "attachment", fileName: "a.bin" });

    await parse(upload);
    await upload.close();
    await upload.close();

    expect(openFileCount(dir)).toBe(0);
  });
});
