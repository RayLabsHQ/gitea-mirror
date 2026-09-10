/**
 * Shared save rule for the destination editors (organizations and repositories).
 *
 * A destination override is stored exactly as typed, and only an empty input
 * clears it. The editors used to collapse a value that happened to equal the
 * default (the organization's own name, or whatever the mirror strategy would
 * produce) into `null`, which silently dropped legitimate overrides: under the
 * `single-org` strategy the default is the configured destination organization,
 * so typing the source organization's own name is a real override (issue #416).
 *
 * Keeping the typed value also makes the pin survive a later strategy change,
 * which is the point of setting one by hand.
 */
export function resolveDestinationSaveValue(input: string): string | null {
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}
