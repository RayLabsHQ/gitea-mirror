import { describe, expect, test } from "bun:test";
import {
  API_KEY_EXPIRY_OPTIONS,
  API_KEY_LENGTH,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PREFIX,
  describeKeyExpiry,
  expiryOptionToSeconds,
  isKeyExpired,
  maskKeyStart,
  normalizeKeyName,
} from "./api-keys";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("api-keys helpers", () => {
  test("prefix ends with an underscore and the key length matches the plugin floor", () => {
    expect(API_KEY_PREFIX.endsWith("_")).toBe(true);
    expect(API_KEY_LENGTH).toBe(64);
  });

  test("expiry options map to seconds, never maps to undefined", () => {
    expect(expiryOptionToSeconds("never")).toBeUndefined();
    expect(expiryOptionToSeconds("30d")).toBe(30 * 24 * 60 * 60);
    expect(expiryOptionToSeconds("90d")).toBe(90 * 24 * 60 * 60);
    expect(expiryOptionToSeconds("1y")).toBe(365 * 24 * 60 * 60);
  });

  test("no option exceeds the plugin's 365 day ceiling", () => {
    for (const option of API_KEY_EXPIRY_OPTIONS) {
      if (option.seconds === null) continue;
      expect(option.seconds / (24 * 60 * 60)).toBeLessThanOrEqual(365);
    }
  });

  test("describeKeyExpiry covers never, future, imminent, past and garbage", () => {
    const now = new Date("2026-09-02T12:00:00Z");
    expect(describeKeyExpiry(null, now)).toBe("Never");
    expect(describeKeyExpiry(undefined, now)).toBe("Never");
    expect(describeKeyExpiry(new Date(now.getTime() + 30 * DAY_MS), now)).toBe("In 30 days");
    expect(describeKeyExpiry(new Date(now.getTime() + 3600 * 1000), now)).toBe("Within a day");
    expect(describeKeyExpiry(new Date(now.getTime() - 1000), now)).toBe("Expired");
    expect(describeKeyExpiry("not a date", now)).toBe("Unknown");
    // ISO strings are what the list endpoint returns over JSON.
    expect(describeKeyExpiry(new Date(now.getTime() + 2 * DAY_MS).toISOString(), now)).toBe("In 2 days");
  });

  test("isKeyExpired treats missing expiry as never expiring", () => {
    const now = new Date("2026-09-02T12:00:00Z");
    expect(isKeyExpired(null, now)).toBe(false);
    expect(isKeyExpired(new Date(now.getTime() + DAY_MS), now)).toBe(false);
    expect(isKeyExpired(new Date(now.getTime() - DAY_MS), now)).toBe(true);
  });

  test("maskKeyStart shows the stored start and falls back to the prefix", () => {
    expect(maskKeyStart("gm_abc1234")).toBe("gm_abc1234••••••••");
    expect(maskKeyStart(null)).toBe("gm_••••••••");
    expect(maskKeyStart("  ")).toBe("gm_••••••••");
  });

  test("normalizeKeyName trims and enforces the plugin's name limit", () => {
    expect(normalizeKeyName("  ci deploy ")).toEqual({ value: "ci deploy", error: null });
    expect(normalizeKeyName("   ").error).toContain("name");
    const long = "x".repeat(API_KEY_NAME_MAX_LENGTH + 1);
    expect(normalizeKeyName(long).error).toContain(String(API_KEY_NAME_MAX_LENGTH));
    expect(normalizeKeyName("x".repeat(API_KEY_NAME_MAX_LENGTH)).error).toBeNull();
  });
});
