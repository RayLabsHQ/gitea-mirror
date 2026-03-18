import { expect, test } from "bun:test";
import {
  buildClockCronExpression,
  getNextCronOccurrence,
  getNextScheduledRun,
  isCronExpression,
  normalizeTimezone,
  parseClockCronExpression,
} from "./schedule-utils";

test("isCronExpression - detects 5-part cron expressions", () => {
  expect(isCronExpression("0 22 * * *")).toBe(true);
  expect(isCronExpression("8h")).toBe(false);
  expect(isCronExpression(3600)).toBe(false);
});

test("buildClockCronExpression - creates daily and hourly expressions", () => {
  expect(buildClockCronExpression("22:00", 24)).toBe("0 22 * * *");
  expect(buildClockCronExpression("22:15", 8)).toBe("15 22,6,14 * * *");
  expect(buildClockCronExpression("10:30", 1)).toBe("30 * * * *");
  expect(buildClockCronExpression("10:30", 7)).toBeNull();
});

test("parseClockCronExpression - parses generated expressions", () => {
  expect(parseClockCronExpression("0 22 * * *")).toEqual({
    startTime: "22:00",
    frequencyHours: 24,
  });
  expect(parseClockCronExpression("15 22,6,14 * * *")).toEqual({
    startTime: "22:15",
    frequencyHours: 8,
  });
  expect(parseClockCronExpression("30 * * * *")).toEqual({
    startTime: "00:30",
    frequencyHours: 1,
  });
  expect(parseClockCronExpression("0 3 * * 1-5")).toBeNull();
});

test("getNextCronOccurrence - computes next run in UTC", () => {
  const from = new Date("2026-03-18T15:20:00.000Z");
  const next = getNextCronOccurrence("0 22 * * *", from, "UTC");
  expect(next.toISOString()).toBe("2026-03-18T22:00:00.000Z");
});

test("getNextCronOccurrence - respects timezone", () => {
  const from = new Date("2026-03-18T15:20:00.000Z");
  // 22:00 IST equals 16:30 UTC
  const next = getNextCronOccurrence("0 22 * * *", from, "Asia/Kolkata");
  expect(next.toISOString()).toBe("2026-03-18T16:30:00.000Z");
});

test("getNextScheduledRun - handles interval and cron schedules", () => {
  const from = new Date("2026-03-18T00:00:00.000Z");
  const intervalNext = getNextScheduledRun("8h", from, "UTC");
  expect(intervalNext.toISOString()).toBe("2026-03-18T08:00:00.000Z");

  const cronNext = getNextScheduledRun("0 */6 * * *", from, "UTC");
  expect(cronNext.toISOString()).toBe("2026-03-18T06:00:00.000Z");
});

test("normalizeTimezone - falls back to UTC for invalid values", () => {
  expect(normalizeTimezone("Invalid/Zone")).toBe("UTC");
  expect(normalizeTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
});
