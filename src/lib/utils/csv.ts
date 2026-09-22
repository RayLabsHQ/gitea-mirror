/**
 * Minimal CSV builder used by the repository and organization exports.
 *
 * Follows RFC 4180: a header row, CRLF line endings, and fields quoted when
 * they hold a comma, a double quote, a carriage return or a line feed, with
 * inner quotes doubled.
 */

/** Fields that need quoting per RFC 4180. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Text that a spreadsheet would run as a formula. Repository descriptions
 * and error messages come from third parties, so a value starting with one
 * of these is prefixed with a single quote, which Excel and Sheets treat as
 * "this is text". Only strings are affected; numbers stay as they are.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Turn one value into its CSV text, before any quoting:
 * null and undefined become empty, dates become ISO strings, booleans become
 * "true" or "false", and anything else is stringified.
 */
export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "object") {
    return JSON.stringify(value) ?? "";
  }

  if (typeof value === "string" && FORMULA_PREFIX.test(value)) {
    return `'${value}`;
  }

  return String(value);
}

/** Format a value and quote it when the content requires it. */
export function escapeCsvValue(value: unknown): string {
  const text = formatCsvValue(value);

  if (!NEEDS_QUOTING.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Build a CSV document from rows and the column keys to export. The keys
 * double as the header row, so the caller controls both the selection and the
 * column order.
 */
export function toCsv<Row>(
  rows: readonly Row[],
  columns: readonly (keyof Row & string)[]
): string {
  const lines: string[] = [columns.map(escapeCsvValue).join(",")];

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvValue(row[column])).join(","));
  }

  return `${lines.join("\r\n")}\r\n`;
}
