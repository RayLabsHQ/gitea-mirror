/**
 * Order for owner, organization and repository names in filter lists: case
 * and accent insensitive, with numbers compared by value. A plain `.sort()`
 * compares code units, so "Zebra" lands before "apple" and umlauts sort last.
 */
const nameCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

export function compareNames(a: string, b: string): number {
  return nameCollator.compare(a, b);
}
