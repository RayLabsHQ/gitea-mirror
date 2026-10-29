import { describe, expect, test } from "bun:test";
import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  test("uses binary units like Gitea", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MiB");
    expect(formatBytes(141 * 1024 ** 3)).toBe("141 GiB");
    expect(formatBytes(2.25 * 1024 ** 4)).toBe("2.3 TiB");
  });

  test("shows nothing as zero", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
