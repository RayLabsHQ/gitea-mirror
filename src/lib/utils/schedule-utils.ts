import { parseInterval } from "@/lib/utils/duration-parser";

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

interface ParsedCronField {
  wildcard: boolean;
  values: Set<number>;
}

interface ZonedDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

interface ParsedCronExpression {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

const zonedPartsFormatterCache = new Map<string, Intl.DateTimeFormat>();
const zonedWeekdayFormatterCache = new Map<string, Intl.DateTimeFormat>();

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function isCronExpression(value: unknown): value is string {
  return typeof value === "string" && value.trim().split(/\s+/).length === 5;
}

export function normalizeTimezone(timezone?: string): string {
  const candidate = timezone?.trim() || "UTC";
  try {
    // Validate timezone eagerly.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return "UTC";
  }
}

function getZonedPartsFormatter(timezone: string): Intl.DateTimeFormat {
  const cacheKey = normalizeTimezone(timezone);
  const cached = zonedPartsFormatterCache.get(cacheKey);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: cacheKey,
    hour12: false,
    hourCycle: "h23",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  zonedPartsFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function getZonedWeekdayFormatter(timezone: string): Intl.DateTimeFormat {
  const cacheKey = normalizeTimezone(timezone);
  const cached = zonedWeekdayFormatterCache.get(cacheKey);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: cacheKey,
    weekday: "short",
  });

  zonedWeekdayFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const safeTimezone = normalizeTimezone(timezone);
  const parts = getZonedPartsFormatter(safeTimezone).formatToParts(date);

  const month = Number(parts.find((part) => part.type === "month")?.value);
  const dayOfMonth = Number(parts.find((part) => part.type === "day")?.value);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);

  const weekdayLabel = getZonedWeekdayFormatter(safeTimezone)
    .format(date)
    .toLowerCase()
    .slice(0, 3);
  const dayOfWeek = WEEKDAY_INDEX[weekdayLabel];

  if (
    Number.isNaN(month) ||
    Number.isNaN(dayOfMonth) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    typeof dayOfWeek !== "number"
  ) {
    throw new Error("Unable to extract timezone-aware date parts");
  }

  return {
    month,
    dayOfMonth,
    hour,
    minute,
    dayOfWeek,
  };
}

function parseCronAtom(
  atom: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
  allowSevenAsSunday = false
): number {
  const normalized = atom.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("Empty cron atom");
  }

  const aliasValue = aliases?.[normalized];
  const parsed = aliasValue ?? Number(normalized);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid cron value: "${atom}"`);
  }

  const normalizedDowValue = allowSevenAsSunday && parsed === 7 ? 0 : parsed;
  if (normalizedDowValue < min || normalizedDowValue > max) {
    throw new Error(
      `Cron value "${atom}" out of range (${min}-${max})`
    );
  }

  return normalizedDowValue;
}

function addRangeValues(
  target: Set<number>,
  start: number,
  end: number,
  step: number,
  min: number,
  max: number
): void {
  if (step <= 0) {
    throw new Error(`Invalid cron step: ${step}`);
  }
  if (start < min || end > max || start > end) {
    throw new Error(`Invalid cron range: ${start}-${end}`);
  }

  for (let value = start; value <= end; value += step) {
    target.add(value);
  }
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
  allowSevenAsSunday = false
): ParsedCronField {
  const raw = field.trim();
  if (raw === "*") {
    const values = new Set<number>();
    for (let i = min; i <= max; i += 1) values.add(i);
    return { wildcard: true, values };
  }

  const values = new Set<number>();
  const segments = raw.split(",");
  for (const segment of segments) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) {
      throw new Error(`Invalid cron field "${field}"`);
    }

    const [basePart, stepPart] = trimmedSegment.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step "${stepPart}"`);
    }

    if (basePart === "*") {
      addRangeValues(values, min, max, step, min, max);
      continue;
    }

    if (basePart.includes("-")) {
      const [startRaw, endRaw] = basePart.split("-");
      const start = parseCronAtom(
        startRaw,
        min,
        max,
        aliases,
        allowSevenAsSunday
      );
      const end = parseCronAtom(
        endRaw,
        min,
        max,
        aliases,
        allowSevenAsSunday
      );
      addRangeValues(values, start, end, step, min, max);
      continue;
    }

    const value = parseCronAtom(
      basePart,
      min,
      max,
      aliases,
      allowSevenAsSunday
    );
    values.add(value);
  }

  return { wildcard: false, values };
}

function parseCronExpression(expression: string): ParsedCronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      'Cron expression must have 5 parts: "minute hour day month weekday"'
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12, MONTH_INDEX),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6, WEEKDAY_INDEX, true),
  };
}

function matchesCron(
  cron: ParsedCronExpression,
  parts: ZonedDateParts
): boolean {
  if (!cron.minute.values.has(parts.minute)) return false;
  if (!cron.hour.values.has(parts.hour)) return false;
  if (!cron.month.values.has(parts.month)) return false;

  const dayOfMonthWildcard = cron.dayOfMonth.wildcard;
  const dayOfWeekWildcard = cron.dayOfWeek.wildcard;
  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);

  if (dayOfMonthWildcard && dayOfWeekWildcard) return true;
  if (dayOfMonthWildcard) return dayOfWeekMatches;
  if (dayOfWeekWildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

export function getNextCronOccurrence(
  expression: string,
  fromDate: Date,
  timezone = "UTC",
  maxLookaheadMinutes = 2 * 365 * 24 * 60
): Date {
  const cron = parseCronExpression(expression);
  const safeTimezone = normalizeTimezone(timezone);

  const base = new Date(fromDate);
  base.setSeconds(0, 0);
  const firstCandidateMs = base.getTime() + 60_000;

  for (let offset = 0; offset <= maxLookaheadMinutes; offset += 1) {
    const candidate = new Date(firstCandidateMs + offset * 60_000);
    const candidateParts = getZonedDateParts(candidate, safeTimezone);
    if (matchesCron(cron, candidateParts)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find next cron occurrence for "${expression}" within ${maxLookaheadMinutes} minutes`
  );
}

export function getNextScheduledRun(
  schedule: string | number,
  fromDate: Date,
  timezone = "UTC"
): Date {
  if (isCronExpression(schedule)) {
    return getNextCronOccurrence(schedule, fromDate, timezone);
  }

  const intervalMs = parseInterval(schedule);
  return new Date(fromDate.getTime() + intervalMs);
}

export function buildClockCronExpression(
  startTime: string,
  frequencyHours: number
): string | null {
  const parsed = startTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!parsed) return null;

  if (!Number.isInteger(frequencyHours) || frequencyHours <= 0) {
    return null;
  }

  const hour = Number(parsed[1]);
  const minute = Number(parsed[2]);

  if (frequencyHours === 24) {
    return `${minute} ${hour} * * *`;
  }

  if (frequencyHours === 1) {
    return `${minute} * * * *`;
  }

  if (24 % frequencyHours !== 0) {
    return null;
  }

  const hourCount = 24 / frequencyHours;
  const hours: number[] = [];
  for (let i = 0; i < hourCount; i += 1) {
    hours.push((hour + i * frequencyHours) % 24);
  }

  return `${minute} ${hours.join(",")} * * *`;
}

export function parseClockCronExpression(
  expression: string
): { startTime: string; frequencyHours: number } | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts;
  if (dayRaw !== "*" || monthRaw !== "*" || weekdayRaw !== "*") {
    return null;
  }

  const minute = Number(minuteRaw);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }

  if (hourRaw === "*") {
    return {
      startTime: `00:${pad2(minute)}`,
      frequencyHours: 1,
    };
  }

  const hourTokens = hourRaw.split(",");
  if (hourTokens.length === 0) return null;

  const hours = hourTokens.map((token) => Number(token));
  if (hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    return null;
  }

  if (hours.length === 1) {
    return {
      startTime: `${pad2(hours[0])}:${pad2(minute)}`,
      frequencyHours: 24,
    };
  }

  // Verify evenly spaced circular sequence to infer "every N hours".
  const deltas: number[] = [];
  for (let i = 0; i < hours.length; i += 1) {
    const current = hours[i];
    const next = i === hours.length - 1 ? hours[0] : hours[i + 1];
    const delta = (next - current + 24) % 24;
    deltas.push(delta);
  }

  const expectedDelta = deltas[0];
  const uniform = deltas.every((delta) => delta === expectedDelta && delta > 0);
  if (!uniform || expectedDelta <= 0 || 24 % expectedDelta !== 0) {
    return null;
  }

  return {
    startTime: `${pad2(hours[0])}:${pad2(minute)}`,
    frequencyHours: expectedDelta,
  };
}
