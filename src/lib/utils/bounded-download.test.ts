import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DownloadLimitError, downloadWithLimits } from "./bounded-download";

let dir: string;
let filePath: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "bounded-download-test-"));
  filePath = path.join(dir, "body");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const encoder = new TextEncoder();

/**
 * A body that sends `chunks` one per `everyMs`, then either ends or goes quiet.
 * Like a fetch body, it fails once the request's signal aborts.
 */
function streamingBody(
  signal: AbortSignal,
  { chunks, everyMs = 1, end = true }: { chunks: string[]; everyMs?: number; end?: boolean }
) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason));
    },
    async pull(controller) {
      if (sent < chunks.length) {
        await Bun.sleep(everyMs);
        if (!signal.aborted) controller.enqueue(encoder.encode(chunks[sent++]));
        return;
      }
      if (end) controller.close();
      else await new Promise(() => {});
    },
  });
}

/** Starts a download and keeps the signal it was handed. */
function recorder(reply: (signal: AbortSignal) => Response | Promise<Response>) {
  const signals: AbortSignal[] = [];
  const start = async (signal: AbortSignal) => {
    signals.push(signal);
    return reply(signal);
  };
  return { start, signals };
}

describe("downloadWithLimits", () => {
  it("writes the body to the file", async () => {
    const { start, signals } = recorder((signal) => new Response(streamingBody(signal, { chunks: ["ab", "cd"] })));

    const download = await downloadWithLimits(start, { stallTimeoutMs: 1000, maxBytes: 4 }, filePath);

    expect(download).toEqual({ ok: true, status: 200, size: 4 });
    expect(await Bun.file(filePath).text()).toBe("abcd");
    expect(signals[0].aborted).toBe(true);
  });

  it("writes each chunk as it arrives instead of holding the body (#523)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let sent = 0;
    const { start } = recorder(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (sent === 0) controller.enqueue(encoder.encode("first "));
              else if (sent === 1) {
                await held;
                controller.enqueue(encoder.encode("second"));
              } else controller.close();
              sent++;
            },
          })
        )
    );

    const download = downloadWithLimits(start, { stallTimeoutMs: 1000 }, filePath);
    // The second chunk is held back: the first must already be on disk.
    let onDisk = "";
    for (let i = 0; i < 100 && onDisk !== "first "; i++) {
      await Bun.sleep(5);
      onDisk = await Bun.file(filePath).text().catch(() => "");
    }
    expect(onDisk).toBe("first ");

    release();
    expect(await download).toEqual({ ok: true, status: 200, size: 12 });
    expect(await Bun.file(filePath).text()).toBe("first second");
  });

  it("hands an error status back and aborts its request without reading it", async () => {
    let pulled = false;
    const { start, signals } = recorder(
      () =>
        new Response(new ReadableStream({ pull: () => void (pulled = true) }, { highWaterMark: 0 }), {
          status: 404,
          statusText: "Not Found",
        })
    );

    const download = await downloadWithLimits(start, { stallTimeoutMs: 1000 }, filePath);

    expect(download).toEqual({ ok: false, status: 404, statusText: "Not Found" });
    expect(signals[0].aborted).toBe(true);
    expect(pulled).toBe(false);
    expect(await Bun.file(filePath).exists()).toBe(false);
  });

  it("stops a body that grows past the cap", async () => {
    const { start, signals } = recorder(
      (signal) => new Response(streamingBody(signal, { chunks: ["aaaa", "bbbb", "cccc"], end: false }))
    );

    const failure = downloadWithLimits(start, { stallTimeoutMs: 1000, maxBytes: 6 }, filePath);

    await expect(failure).rejects.toBeInstanceOf(DownloadLimitError);
    await expect(failure).rejects.toThrow("Larger than 6 bytes");
    expect(signals[0].aborted).toBe(true);
  });

  it("refuses a declared length past the cap before reading", async () => {
    let pulled = false;
    const { start, signals } = recorder(
      () =>
        new Response(new ReadableStream({ pull: () => void (pulled = true) }, { highWaterMark: 0 }), {
          headers: { "content-length": String(2 * 1024 * 1024) },
        })
    );

    await expect(downloadWithLimits(start, { stallTimeoutMs: 1000, maxBytes: 1024 * 1024 }, filePath)).rejects.toThrow(
      "Larger than 1 MB"
    );
    expect(signals[0].aborted).toBe(true);
    expect(pulled).toBe(false);
  });

  it("gives up when the body goes quiet", async () => {
    const { start, signals } = recorder(
      (signal) => new Response(streamingBody(signal, { chunks: ["a"], end: false }))
    );

    await expect(downloadWithLimits(start, { stallTimeoutMs: 40 }, filePath)).rejects.toThrow("No data for 0 s");
    expect(signals[0].aborted).toBe(true);
  });

  it("gives up when the headers never come", async () => {
    const { start } = recorder(
      (signal) =>
        new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
    );

    await expect(downloadWithLimits(start, { stallTimeoutMs: 40 }, filePath)).rejects.toBeInstanceOf(DownloadLimitError);
  });

  it("gives up on a slow drip at the total time", async () => {
    const chunks = new Array(1000).fill("x");
    const { start, signals } = recorder(
      (signal) => new Response(streamingBody(signal, { chunks, everyMs: 10 }))
    );

    await expect(
      downloadWithLimits(start, { stallTimeoutMs: 1000, totalTimeoutMs: 80 }, filePath)
    ).rejects.toThrow("The download took longer than");
    expect(signals[0].aborted).toBe(true);
  });

  it("ends a read on a body that ignores the abort", async () => {
    const { start } = recorder(
      () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise(() => {}),
          })
        )
    );

    const ended = await Promise.race([
      downloadWithLimits(start, { stallTimeoutMs: 40 }, filePath).catch((error: Error) => error.message),
      Bun.sleep(1000).then(() => "still reading after 1 s"),
    ]);
    expect(ended).toBe("No data for 0 s");
  });

  it("passes other errors through", async () => {
    const { start, signals } = recorder(() => {
      throw new Error("refused by the guard");
    });

    await expect(downloadWithLimits(start, { stallTimeoutMs: 1000 }, filePath)).rejects.toThrow("refused by the guard");
    expect(signals[0].aborted).toBe(true);
  });
});
