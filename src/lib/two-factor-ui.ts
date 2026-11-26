/** Text helpers for the two-factor screens (#552), kept free of React for tests. */

/** Plain words for the two-factor plugin's error codes. */
export function twoFactorErrorText(
  error: { code?: string; message?: string } | null | undefined,
  fallback = "Verification failed",
): string {
  switch (error?.code) {
    case "INVALID_PASSWORD":
      return "Wrong password";
    case "INVALID_CODE":
      return "That code didn't work. Check the time on your phone and try the current code.";
    case "INVALID_BACKUP_CODE":
      return "That backup code didn't work. Each code works only once.";
    case "INVALID_TWO_FACTOR_COOKIE":
      return "This login timed out. Enter your password again.";
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      return "Too many tries. Enter your password again.";
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return "Too many wrong codes. Wait 15 minutes and try again.";
    default:
      return error?.message || fallback;
  }
}

/** The secret from an otpauth:// URI, in groups of four for typing by hand. */
export function manualEntryKey(totpURI: string): string {
  try {
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    return secret.replace(/(.{4})/g, "$1 ").trim();
  } catch {
    return "";
  }
}
