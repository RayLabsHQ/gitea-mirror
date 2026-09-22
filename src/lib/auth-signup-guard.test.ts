import { describe, expect, it } from "bun:test";
import {
  isOpenRegistration,
  isSignupClosed,
  isSignupRequest,
  signupClosedError,
  signupGuardPlugin,
} from "./auth-signup-guard";

describe("signup guard", () => {
  it("only matches the email sign-up endpoint", () => {
    expect(isSignupRequest("/sign-up/email")).toBe(true);
    expect(isSignupRequest("/sign-in/email")).toBe(false);
    expect(isSignupRequest("/sign-up/email/extra")).toBe(false);
    expect(isSignupRequest(undefined)).toBe(false);
  });

  it("opens registration only for the literal true", () => {
    expect(isOpenRegistration({ AUTH_ALLOW_SIGNUP: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOpenRegistration({ AUTH_ALLOW_SIGNUP: "TRUE" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOpenRegistration({ AUTH_ALLOW_SIGNUP: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOpenRegistration({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("closes sign-up once a user exists unless registration is open", () => {
    expect(isSignupClosed({ userCount: 0, allowSignup: false })).toBe(false);
    expect(isSignupClosed({ userCount: 1, allowSignup: false })).toBe(true);
    expect(isSignupClosed({ userCount: 5, allowSignup: true })).toBe(false);
  });

  it("answers 403 with a stable code", () => {
    const error = signupClosedError();
    expect(error.status).toBe("FORBIDDEN");
    expect(error.body?.code).toBe("SIGNUP_CLOSED");
  });

  it("registers a before hook on the sign-up path that counts users", async () => {
    let counted = 0;
    const plugin = signupGuardPlugin({
      countUsers: async () => {
        counted += 1;
        return 1;
      },
    });
    const hook = plugin.hooks.before[0];
    expect(hook.matcher({ path: "/sign-up/email" } as any)).toBe(true);
    expect(hook.matcher({ path: "/sign-in/email" } as any)).toBe(false);

    const previous = process.env.AUTH_ALLOW_SIGNUP;
    delete process.env.AUTH_ALLOW_SIGNUP;
    try {
      await expect(hook.handler({ path: "/sign-up/email", context: {} } as any)).rejects.toMatchObject({
        body: { code: "SIGNUP_CLOSED" },
      });
      expect(counted).toBe(1);

      process.env.AUTH_ALLOW_SIGNUP = "true";
      await hook.handler({ path: "/sign-up/email", context: {} } as any);
      expect(counted).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.AUTH_ALLOW_SIGNUP;
      else process.env.AUTH_ALLOW_SIGNUP = previous;
    }
  });
});
