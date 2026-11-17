import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { multipartFileBody } from "./multipart-file-body";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "multipart-file-body-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Parses the body the way a server would. */
async function parse(upload: ReturnType<typeof multipartFileBody>) {
  const request = new Request("http://destination.test/upload", {
    method: "POST",
    headers: { "content-type": upload.contentType },
    body: upload.body,
    duplex: "half",
  } as RequestInit);
  return request.formData();
}

describe("multipartFileBody", () => {
  it("carries the file under the field and name given", async () => {
    const filePath = path.join(dir, "asset");
    const bytes = new Uint8Array(3 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    await writeFile(filePath, bytes);

    const form = await parse(multipartFileBody(filePath, { field: "attachment", fileName: "tool-1.0.tar.gz" }));

    const file = form.get("attachment") as File;
    expect(file.name).toBe("tool-1.0.tar.gz");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("keeps quotes and line breaks in a name from breaking the part", async () => {
    const filePath = path.join(dir, "asset");
    await writeFile(filePath, "body");

    const form = await parse(multipartFileBody(filePath, { field: "attachment", fileName: 'a"b\r\nc.zip' }));

    expect([...form.keys()]).toEqual(["attachment"]);
    expect(await (form.get("attachment") as File).text()).toBe("body");
  });

  it("does not open the file until the body is read", async () => {
    const filePath = path.join(dir, "written-later");
    const upload = multipartFileBody(filePath, { field: "attachment", fileName: "late.bin" });
    await writeFile(filePath, "late");

    expect(await ((await parse(upload)).get("attachment") as File).text()).toBe("late");
  });
});
