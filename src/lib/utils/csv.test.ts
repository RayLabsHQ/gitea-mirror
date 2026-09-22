import { describe, test, expect } from "bun:test";
import { escapeCsvValue, formatCsvValue, toCsv } from "./csv";

describe("formatCsvValue", () => {
  test("empty for null and undefined", () => {
    expect(formatCsvValue(null)).toBe("");
    expect(formatCsvValue(undefined)).toBe("");
  });

  test("dates become ISO strings", () => {
    expect(formatCsvValue(new Date("2026-09-22T08:30:00.000Z"))).toBe(
      "2026-09-22T08:30:00.000Z"
    );
  });

  test("an invalid date is empty rather than 'Invalid Date'", () => {
    expect(formatCsvValue(new Date("nope"))).toBe("");
  });

  test("booleans become true and false", () => {
    expect(formatCsvValue(true)).toBe("true");
    expect(formatCsvValue(false)).toBe("false");
  });

  test("numbers keep their text form, including zero", () => {
    expect(formatCsvValue(0)).toBe("0");
    expect(formatCsvValue(42)).toBe("42");
  });

  test("objects are stringified as JSON", () => {
    expect(formatCsvValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("escapeCsvValue", () => {
  test("leaves a plain value alone", () => {
    expect(escapeCsvValue("hello-world")).toBe("hello-world");
  });

  test("quotes a value with a comma", () => {
    expect(escapeCsvValue("one, two")).toBe('"one, two"');
  });

  test("quotes a value with a quote and doubles the quote", () => {
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
  });

  test("a value that is only quotes doubles every one of them", () => {
    expect(escapeCsvValue('"""')).toBe('""""""""');
  });

  test("quotes a value with a line feed", () => {
    expect(escapeCsvValue("first\nsecond")).toBe('"first\nsecond"');
  });

  test("quotes a value with a carriage return", () => {
    expect(escapeCsvValue("first\r\nsecond")).toBe('"first\r\nsecond"');
  });

  test("keeps leading and trailing spaces without quoting", () => {
    expect(escapeCsvValue("  padded  ")).toBe("  padded  ");
  });
});

describe("toCsv", () => {
  type Row = {
    name: string;
    description: string | null;
    isPrivate: boolean;
    size: number;
    lastMirrored: Date | null;
  };

  const columns = [
    "name",
    "description",
    "isPrivate",
    "size",
    "lastMirrored",
  ] as const;

  test("writes a header row from the column keys", () => {
    const csv = toCsv<Row>([], columns);
    expect(csv).toBe("name,description,isPrivate,size,lastMirrored\r\n");
  });

  test("writes one CRLF terminated line per row", () => {
    const csv = toCsv<Row>(
      [
        {
          name: "hello-world",
          description: "A greeting",
          isPrivate: false,
          size: 12,
          lastMirrored: new Date("2026-09-22T08:30:00.000Z"),
        },
        {
          name: "second",
          description: null,
          isPrivate: true,
          size: 0,
          lastMirrored: null,
        },
      ],
      columns
    );

    expect(csv).toBe(
      "name,description,isPrivate,size,lastMirrored\r\n" +
        "hello-world,A greeting,false,12,2026-09-22T08:30:00.000Z\r\n" +
        "second,,true,0,\r\n"
    );
  });

  test("escapes values that hold commas, quotes and newlines", () => {
    const csv = toCsv<Row>(
      [
        {
          name: "tricky",
          description: 'Uses "quotes", commas\nand a newline',
          isPrivate: false,
          size: 1,
          lastMirrored: null,
        },
      ],
      columns
    );

    expect(csv.split("\r\n")[1]).toBe(
      'tricky,"Uses ""quotes"", commas\nand a newline",false,1,'
    );
  });

  test("escapes a header that needs quoting too", () => {
    const csv = toCsv<{ "size, bytes": number }>([{ "size, bytes": 3 }], [
      "size, bytes",
    ]);
    expect(csv).toBe('"size, bytes"\r\n3\r\n');
  });

  test("a missing key on a row is an empty field", () => {
    const rows = [{ name: "partial" }] as unknown as Row[];
    const csv = toCsv<Row>(rows, columns);
    expect(csv.split("\r\n")[1]).toBe("partial,,,,");
  });

  test("only the listed columns are written, in the listed order", () => {
    const rows = [
      { name: "a", secret: "token", description: "b" },
    ] as unknown as Row[];
    const csv = toCsv<Row>(rows, ["description", "name"]);
    expect(csv).toBe("description,name\r\nb,a\r\n");
    expect(csv).not.toContain("token");
  });
});

describe("formula injection guard", () => {
  test("prefixes strings a spreadsheet would run as a formula", () => {
    expect(formatCsvValue("=1+1")).toBe("'=1+1");
    expect(formatCsvValue("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(formatCsvValue("-2+3")).toBe("'-2+3");
    expect(formatCsvValue("@cmd")).toBe("'@cmd");
    expect(formatCsvValue("\t=1")).toBe("'\t=1");
  });

  test("leaves numbers, booleans and ordinary text alone", () => {
    expect(formatCsvValue(-5)).toBe("-5");
    expect(formatCsvValue(true)).toBe("true");
    expect(formatCsvValue("a - b")).toBe("a - b");
    expect(formatCsvValue("main")).toBe("main");
  });

  test("still quotes a guarded value that needs quoting", () => {
    expect(escapeCsvValue('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });
});
