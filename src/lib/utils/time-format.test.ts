import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  TIME_FORMAT_STORAGE_KEY,
  isTimeFormatPreference,
  getTimeFormatPreference,
  setTimeFormatPreference,
  subscribeToTimeFormatChange,
  resolveHour12,
  formatDateTime,
  formatShortDateTime,
  formatTime,
} from "./time-format";

// A fixed instant; assertions below are timezone-agnostic (they check the
// hour cycle / AM-PM marker, not exact clock values).
const FIXED_DATE = new Date("2023-01-15T12:30:45Z");
const MERIDIEM = /AM|PM/i;

// The Bun test runtime has no DOM. Install minimal localStorage/window shims
// for the persistence and subscription tests, and remove them afterwards.
const g = globalThis as any;
const createdLocalStorage = typeof g.localStorage === "undefined";
const createdWindow = typeof g.window === "undefined";

beforeAll(() => {
  if (createdLocalStorage) {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };
  }
  if (createdWindow) {
    const target = new EventTarget();
    g.window = target;
  }
});

afterAll(() => {
  if (createdLocalStorage) delete g.localStorage;
  if (createdWindow) delete g.window;
});

beforeEach(() => {
  g.localStorage.removeItem(TIME_FORMAT_STORAGE_KEY);
});

describe("isTimeFormatPreference", () => {
  test("accepts valid preferences", () => {
    expect(isTimeFormatPreference("auto")).toBe(true);
    expect(isTimeFormatPreference("12h")).toBe(true);
    expect(isTimeFormatPreference("24h")).toBe(true);
  });

  test("rejects invalid values", () => {
    expect(isTimeFormatPreference("24")).toBe(false);
    expect(isTimeFormatPreference("")).toBe(false);
    expect(isTimeFormatPreference(null)).toBe(false);
    expect(isTimeFormatPreference(undefined)).toBe(false);
    expect(isTimeFormatPreference(12)).toBe(false);
  });
});

describe("resolveHour12", () => {
  test("maps preferences onto Intl's hour12 option", () => {
    expect(resolveHour12("12h")).toBe(true);
    expect(resolveHour12("24h")).toBe(false);
    expect(resolveHour12("auto")).toBeUndefined();
  });
});

describe("preference persistence", () => {
  test("defaults to 'auto' when nothing is stored", () => {
    expect(getTimeFormatPreference()).toBe("auto");
  });

  test("round-trips a stored preference", () => {
    setTimeFormatPreference("24h");
    expect(getTimeFormatPreference()).toBe("24h");
    setTimeFormatPreference("12h");
    expect(getTimeFormatPreference()).toBe("12h");
  });

  test("falls back to 'auto' for corrupted stored values", () => {
    g.localStorage.setItem(TIME_FORMAT_STORAGE_KEY, "bogus");
    expect(getTimeFormatPreference()).toBe("auto");
  });
});

describe("subscribeToTimeFormatChange", () => {
  test("notifies on preference change and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeToTimeFormatChange(() => {
      calls++;
    });

    setTimeFormatPreference("24h");
    expect(calls).toBe(1);

    setTimeFormatPreference("12h");
    expect(calls).toBe(2);

    unsubscribe();
    setTimeFormatPreference("auto");
    expect(calls).toBe(2);
  });

  test("notifies on cross-tab storage events for our key only", () => {
    let calls = 0;
    const unsubscribe = subscribeToTimeFormatChange(() => {
      calls++;
    });

    g.window.dispatchEvent(
      Object.assign(new Event("storage"), { key: TIME_FORMAT_STORAGE_KEY })
    );
    expect(calls).toBe(1);

    g.window.dispatchEvent(
      Object.assign(new Event("storage"), { key: "theme" })
    );
    expect(calls).toBe(1);

    unsubscribe();
  });
});

describe("formatTime", () => {
  test("forces 24-hour time regardless of a 12-hour locale", () => {
    const formatted = formatTime(FIXED_DATE, {
      locale: "en-US",
      preference: "24h",
    });
    expect(formatted).not.toMatch(MERIDIEM);
    expect(formatted).toMatch(/^\d{2}:\d{2}$/);
  });

  test("forces 12-hour time regardless of a 24-hour locale", () => {
    const formatted = formatTime(FIXED_DATE, {
      locale: "de-DE",
      preference: "12h",
    });
    expect(formatted).toMatch(MERIDIEM);
  });

  test("'auto' follows the locale convention (12h for en-US)", () => {
    const formatted = formatTime(FIXED_DATE, {
      locale: "en-US",
      preference: "auto",
    });
    expect(formatted).toMatch(MERIDIEM);
  });

  test("'auto' follows the locale convention (24h for de-DE)", () => {
    const formatted = formatTime(FIXED_DATE, {
      locale: "de-DE",
      preference: "auto",
    });
    expect(formatted).not.toMatch(MERIDIEM);
  });

  test("uses the stored preference when none is passed", () => {
    setTimeFormatPreference("24h");
    const formatted = formatTime(FIXED_DATE, { locale: "en-US" });
    expect(formatted).not.toMatch(MERIDIEM);
    expect(formatted).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("formatDateTime", () => {
  test("includes the full date and respects the 24h preference", () => {
    const formatted = formatDateTime(FIXED_DATE, {
      locale: "en-US",
      preference: "24h",
    });
    expect(formatted).toContain("January");
    expect(formatted).toContain("2023");
    expect(formatted).not.toMatch(MERIDIEM);
    expect(formatted).toMatch(/\d{2}:\d{2}/);
  });

  test("includes the full date and respects the 12h preference", () => {
    const formatted = formatDateTime(FIXED_DATE, {
      locale: "en-US",
      preference: "12h",
    });
    expect(formatted).toContain("January");
    expect(formatted).toContain("2023");
    expect(formatted).toMatch(MERIDIEM);
  });

  test("accepts ISO strings and epoch milliseconds", () => {
    const fromString = formatDateTime("2023-01-15T12:30:45Z", {
      locale: "en-US",
      preference: "24h",
    });
    const fromNumber = formatDateTime(FIXED_DATE.getTime(), {
      locale: "en-US",
      preference: "24h",
    });
    expect(fromString).toBe(fromNumber);
  });
});

describe("formatShortDateTime", () => {
  test("renders a compact numeric date with time", () => {
    const formatted = formatShortDateTime(FIXED_DATE, {
      locale: "en-US",
      preference: "12h",
    });
    expect(formatted).toMatch(/\d{2}\/\d{2}\/\d{2}/);
    expect(formatted).toMatch(MERIDIEM);
  });

  test("respects the 24h preference", () => {
    const formatted = formatShortDateTime(FIXED_DATE, {
      locale: "en-US",
      preference: "24h",
    });
    expect(formatted).not.toMatch(MERIDIEM);
    expect(formatted).toMatch(/\d{2}:\d{2}/);
  });
});
