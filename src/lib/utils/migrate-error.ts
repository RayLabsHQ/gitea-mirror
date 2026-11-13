/**
 * Why the destination refused to create a mirror.
 *
 * Gitea and Forgejo answer a rejected `POST /repos/migrate` with a 4xx and a
 * JSON body whose `message` is a plain sentence, such as "You can not import
 * from disallowed hosts." The HTTP client keeps upstream bodies out of error
 * messages on purpose, which left the user with a bare "HTTP 422:
 * Unprocessable Entity" and nothing to act on (#511).
 *
 * This is the one call where the sentence is put back. It stays narrow: only a
 * 4xx, only the `message` string of a JSON body, one line, capped, with any
 * credentials in a URL removed.
 */

const MAX_REASON_LENGTH = 200;

interface HttpErrorLike extends Error {
  status: number;
  response?: string;
}

function isHttpErrorLike(error: unknown): error is HttpErrorLike {
  return (
    error instanceof Error &&
    typeof (error as { status?: unknown }).status === "number"
  );
}

export function migrateRejectionReason(error: unknown): string | null {
  if (!isHttpErrorLike(error)) return null;
  if (error.status < 400 || error.status >= 500) return null;
  if (typeof error.response !== "string" || !error.response) return null;

  let message: unknown;
  try {
    message = (JSON.parse(error.response) as { message?: unknown })?.message;
  } catch {
    return null;
  }
  if (typeof message !== "string") return null;

  const oneLine = message
    // Control characters and line breaks become spaces.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // user:password@ inside a URL never reaches the UI.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return null;

  return oneLine.length > MAX_REASON_LENGTH
    ? `${oneLine.slice(0, MAX_REASON_LENGTH)}...`
    : oneLine;
}

/**
 * Adds the destination's reason to a failed migrate request's message and
 * returns the same error, so its class, status and stack are unchanged.
 */
export function withMigrateRejectionReason<T>(error: T): T {
  const reason = migrateRejectionReason(error);
  if (reason && error instanceof Error && !error.message.includes(reason)) {
    error.message = `${error.message} (destination replied: ${reason})`;
  }
  return error;
}
