import { describe, expect, test } from "bun:test";
import { isGiteaImportRunning, isMigrateCutOff, waitForGiteaImport } from "./gitea-import-wait";
import { HttpError } from "./http-client";

// What Gitea 1.24.7 answers for a pull mirror during and after its import.
const IMPORTING = { mirror: true, empty: true, mirror_interval: "" };
const IMPORTED = { mirror: true, empty: false, mirror_interval: "8h0m0s" };

// Forgejo 17.0.1, read live while it imported golang/go after the caller had hung
// up (#521). A failed import stays exactly like the first one.
const FORGEJO_IMPORTING = {
  mirror: true,
  empty: true,
  mirror_interval: "",
  mirror_updated: "0001-01-01T00:00:00Z",
  size: 0,
};
const FORGEJO_IMPORTED = {
  mirror: true,
  empty: false,
  mirror_interval: "8h0m0s",
  mirror_updated: "2026-11-16T16:35:28+05:30",
  size: 674111,
};

describe("isGiteaImportRunning", () => {
  test("an empty repository with no mirror interval yet is importing", () => {
    expect(isGiteaImportRunning(IMPORTING)).toBe(true);
  });

  test("a finished import is not", () => {
    expect(isGiteaImportRunning(IMPORTED)).toBe(false);
  });

  test("a mirror of an empty source has its interval once the import ends", () => {
    expect(isGiteaImportRunning({ empty: true, mirror_interval: "8h0m0s" })).toBe(false);
  });

  test("a mirror that lost its record but has content does not hold anything up", () => {
    expect(isGiteaImportRunning({ empty: false, mirror_interval: "" })).toBe(false);
  });

  test("a server that leaves the fields out does not hold anything up", () => {
    expect(isGiteaImportRunning({})).toBe(false);
    expect(isGiteaImportRunning({ empty: true })).toBe(false);
  });

  test("an App backed mirror with no schedule is not importing", () => {
    expect(isGiteaImportRunning({ empty: false, mirror_interval: "0s" })).toBe(false);
  });

  test("Forgejo answers the same way during and after an import", () => {
    expect(isGiteaImportRunning(FORGEJO_IMPORTING)).toBe(true);
    expect(isGiteaImportRunning(FORGEJO_IMPORTED)).toBe(false);
  });
});

describe("isMigrateCutOff", () => {
  test("our own request giving up is a cut off, not an answer", () => {
    // How Bun's five minute fetch timeout reaches the caller through httpRequest.
    expect(isMigrateCutOff(new HttpError("Network error: The operation timed out.", 0, "Network Error"))).toBe(true);
  });

  test("a proxy giving up is too", () => {
    expect(isMigrateCutOff(new HttpError("HTTP 502: Bad Gateway", 502, "Bad Gateway"))).toBe(true);
    expect(isMigrateCutOff(new HttpError("HTTP 504: Gateway Timeout", 504, "Gateway Timeout"))).toBe(true);
  });

  test("anything Gitea answered itself is not", () => {
    for (const status of [400, 401, 403, 409, 422, 500, 503]) {
      expect(isMigrateCutOff(new HttpError(`HTTP ${status}`, status, ""))).toBe(false);
    }
  });

  test("errors without a status are not", () => {
    expect(isMigrateCutOff(new Error("boom"))).toBe(false);
    expect(isMigrateCutOff(null)).toBe(false);
    expect(isMigrateCutOff(undefined)).toBe(false);
  });
});

describe("waitForGiteaImport", () => {
  function clock() {
    let time = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
      },
    };
  }

  test("a finished import returns at once without reading anything", async () => {
    const { now, sleep, sleeps } = clock();
    let reads = 0;

    await waitForGiteaImport({
      location: "o/r",
      initial: IMPORTED,
      readRepo: async () => {
        reads++;
        return IMPORTED;
      },
      now,
      sleep,
    });

    expect(reads).toBe(0);
    expect(sleeps).toEqual([]);
  });

  test("hands back what it started with when nothing is importing", async () => {
    const result = await waitForGiteaImport({
      location: "o/r",
      initial: FORGEJO_IMPORTED,
      readRepo: async () => null,
    });

    expect(result).toBe(FORGEJO_IMPORTED);
  });

  test("hands back the finished repository", async () => {
    const { now, sleep } = clock();
    const answers = [FORGEJO_IMPORTING, FORGEJO_IMPORTED];

    const result = await waitForGiteaImport({
      location: "o/r",
      initial: FORGEJO_IMPORTING,
      readRepo: async () => answers.shift()!,
      now,
      sleep,
    });

    expect(result).toBe(FORGEJO_IMPORTED);
  });

  test("polls until the import ends", async () => {
    const { now, sleep, sleeps } = clock();
    const answers = [IMPORTING, IMPORTING, IMPORTED];

    await waitForGiteaImport({
      location: "o/r",
      initial: IMPORTING,
      readRepo: async () => answers.shift()!,
      pollMs: 5_000,
      now,
      sleep,
    });

    expect(answers).toEqual([]);
    expect(sleeps).toEqual([5_000, 5_000, 5_000]);
  });

  test("fails when the repository disappears during the wait", async () => {
    const { now, sleep } = clock();

    await expect(
      waitForGiteaImport({ location: "o/r", initial: IMPORTING, readRepo: async () => null, now, sleep })
    ).rejects.toThrow("Gitea's import of o/r failed: the repository is gone.");
  });

  test("gives up after the wait and says what is going on", async () => {
    const { now, sleep, sleeps } = clock();

    await expect(
      waitForGiteaImport({
        location: "o/r",
        initial: IMPORTING,
        readRepo: async () => IMPORTING,
        waitMs: 60_000,
        pollMs: 20_000,
        now,
        sleep,
      })
    ).rejects.toThrow(
      "Gitea is still importing o/r after 1 minutes. Retry once it has finished. " +
        "A failed import stays in this state, so if it has looked like this for hours, " +
        "delete the repository in Gitea and retry."
    );

    expect(sleeps).toHaveLength(3);
  });
});
