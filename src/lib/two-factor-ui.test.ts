import { describe, expect, test } from "bun:test";
import { isAuthRedirect } from "./auth-redirect";
import { manualEntryKey, twoFactorErrorText } from "./two-factor-ui";

describe("two-factor screens (#552)", () => {
  test("error codes read as plain words, anything else keeps its message", () => {
    expect(twoFactorErrorText({ code: "INVALID_PASSWORD", message: "Invalid password" })).toBe("Wrong password");
    expect(twoFactorErrorText({ code: "INVALID_CODE" })).toContain("Check the time on your phone");
    expect(twoFactorErrorText({ code: "ACCOUNT_TEMPORARILY_LOCKED" })).toContain("15 minutes");
    expect(twoFactorErrorText({ code: "SOMETHING_ELSE", message: "Server said no" })).toBe("Server said no");
    expect(twoFactorErrorText(null, "Could not start the setup")).toBe("Could not start the setup");
    expect(twoFactorErrorText(undefined)).toBe("Verification failed");
  });

  test("the key for typing by hand comes from the QR code's URI in groups of four", () => {
    expect(
      manualEntryKey("otpauth://totp/Gitea%20Mirror:a%40b.c?secret=MVLEKWDFKZRHO3SZN5&issuer=Gitea+Mirror&digits=6&period=30"),
    ).toBe("MVLE KWDF KZRH O3SZ N5");
    expect(manualEntryKey("not a uri")).toBe("");
    expect(manualEntryKey("otpauth://totp/x?issuer=y")).toBe("");
  });

  test("a login answer that already sends the browser to an app is recognized", () => {
    expect(isAuthRedirect({ redirect: true, url: "http://127.0.0.1:4499/cb?code=abc&state=s" })).toBe(true);
    expect(isAuthRedirect({ redirect: true, url: "/oauth/consent?client_id=x" })).toBe(true);
    // The schemes Better Auth's client refuses to follow, so the form must.
    expect(isAuthRedirect({ redirect: true, url: "javascript:alert(1)" })).toBe(false);
    expect(isAuthRedirect({ redirect: true, url: "" })).toBe(false);
    expect(isAuthRedirect({ redirect: false, url: "/x" })).toBe(false);
    expect(isAuthRedirect({ twoFactorRedirect: true })).toBe(false);
    expect(isAuthRedirect(null)).toBe(false);
  });
});
