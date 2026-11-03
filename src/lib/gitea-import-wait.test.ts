import { describe, expect, test } from "bun:test";
import { isGiteaImportRunning, waitForGiteaImport } from "./gitea-import-wait";

// What Gitea 1.24.7 answers for a pull mirror during and after its import.
const IMPORTING = { mirror: true, empty: true, mirror_interval: "" };
const IMPORTED = { mirror: true, empty: false, mirror_interval: "8h0m0s" };

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

  test("fails when Gitea dropped the repository, which is what a failed import does", async () => {
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
    ).rejects.toThrow("Gitea is still importing o/r after 1 minutes. Retry once it has finished.");

    expect(sleeps).toHaveLength(3);
  });
});
