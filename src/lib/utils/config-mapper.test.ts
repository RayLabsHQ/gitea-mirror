import { expect, test } from "bun:test";
import { mapDbScheduleToUi, mapUiScheduleToDb } from "./config-mapper";
import { scheduleConfigSchema } from "@/lib/db/schema";

test("mapUiScheduleToDb - builds cron from start time + frequency", () => {
  const existing = scheduleConfigSchema.parse({});
  const mapped = mapUiScheduleToDb(
    {
      enabled: true,
      scheduleMode: "clock",
      clockFrequencyHours: 24,
      startTime: "22:00",
      timezone: "Asia/Kolkata",
    },
    existing
  );

  expect(mapped.enabled).toBe(true);
  expect(mapped.interval).toBe("0 22 * * *");
  expect(mapped.timezone).toBe("Asia/Kolkata");
});

test("mapDbScheduleToUi - infers clock mode for generated cron", () => {
  const mapped = mapDbScheduleToUi(
    scheduleConfigSchema.parse({
      enabled: true,
      interval: "15 22,6,14 * * *",
      timezone: "Asia/Kolkata",
    })
  );

  expect(mapped.scheduleMode).toBe("clock");
  expect(mapped.clockFrequencyHours).toBe(8);
  expect(mapped.startTime).toBe("22:15");
  expect(mapped.timezone).toBe("Asia/Kolkata");
});
