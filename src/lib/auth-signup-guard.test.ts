import { describe, expect, it } from "bun:test";
import {
  createSsoSignupCheck,
  emailMatchesProviderDomain,
  isOpenRegistration,
  isSignupClosed,
  isSignupRequest,
  isSsoPath,
  signupClosedError,
  signupGuardPlugin,
  ssoSignupAllowed,
} from "./auth-signup-guard";

async function withAllowSignup<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AUTH_ALLOW_SIGNUP;
  if (value === undefined) delete process.env.AUTH_ALLOW_SIGNUP;
  else process.env.AUTH_ALLOW_SIGNUP = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.AUTH_ALLOW_SIGNUP;
    else process.env.AUTH_ALLOW_SIGNUP = previous;
  }
}

const noProvider = async () => null;

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
      findSsoProviderDomain: noProvider,
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

describe("SSO sign-up guard", () => {
  it("matches the SSO plugin's endpoints only", () => {
    expect(isSsoPath("/sso/callback/google")).toBe(true);
    expect(isSsoPath("/sso/saml2/sp/acs/okta")).toBe(true);
    expect(isSsoPath("/sso/callback")).toBe(true);
    expect(isSsoPath("/sign-in/sso")).toBe(false);
    expect(isSsoPath("/sign-up/email")).toBe(false);
    expect(isSsoPath("/sign-in/header")).toBe(false);
    expect(isSsoPath(undefined)).toBe(false);
  });

  it("matches an email against the provider's domains and their subdomains", () => {
    expect(emailMatchesProviderDomain("a@example.com", "example.com")).toBe(true);
    expect(emailMatchesProviderDomain("a@EXAMPLE.com", " Example.COM ")).toBe(true);
    expect(emailMatchesProviderDomain("a@eu.example.com", "example.com")).toBe(true);
    expect(emailMatchesProviderDomain("a@example.org", "example.com, example.org")).toBe(true);
    expect(emailMatchesProviderDomain("a@gmail.com", "example.com")).toBe(false);
    expect(emailMatchesProviderDomain("a@badexample.com", "example.com")).toBe(false);
    expect(emailMatchesProviderDomain("a@example.com.evil.net", "example.com")).toBe(false);
    expect(emailMatchesProviderDomain("a@x@gmail.com", "example.com")).toBe(false);
    expect(emailMatchesProviderDomain("no-at-sign", "example.com")).toBe(false);
    expect(emailMatchesProviderDomain("a@example.com", "")).toBe(false);
    expect(emailMatchesProviderDomain("a@example.com", null)).toBe(false);
    expect(emailMatchesProviderDomain(undefined, "example.com")).toBe(false);
  });

  it("allows the first account, open registration, or an email in the provider's domain", () => {
    const base = { email: "a@gmail.com", providerDomain: "example.com" };
    expect(ssoSignupAllowed({ ...base, userCount: 0, allowSignup: false })).toBe(true);
    expect(ssoSignupAllowed({ ...base, userCount: 1, allowSignup: true })).toBe(true);
    expect(ssoSignupAllowed({ ...base, userCount: 1, allowSignup: false })).toBe(false);
    expect(
      ssoSignupAllowed({ userCount: 1, allowSignup: false, email: "a@example.com", providerDomain: "example.com" }),
    ).toBe(true);
    expect(
      ssoSignupAllowed({ userCount: 1, allowSignup: false, email: "a@example.com", providerDomain: null }),
    ).toBe(false);
  });

  it("is registered as a user create hook through the plugin's init", () => {
    const plugin = signupGuardPlugin({ countUsers: async () => 0, findSsoProviderDomain: noProvider });
    const before = plugin.init().options.databaseHooks.user.create.before;
    expect(typeof before).toBe("function");
  });

  it("refuses a new SSO account outside the provider's domain once a user exists", async () => {
    const lookups: string[] = [];
    const check = createSsoSignupCheck({
      countUsers: async () => 1,
      findSsoProviderDomain: async (providerId) => {
        lookups.push(providerId);
        return providerId === "corp" ? "example.com" : null;
      },
    });

    await withAllowSignup(undefined, async () => {
      await expect(
        check({ email: "someone@gmail.com" }, { path: "/sso/callback/corp", params: { providerId: "corp" } }),
      ).rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });

      await check({ email: "new@example.com" }, { path: "/sso/callback/corp", params: { providerId: "corp" } });
      await check({ email: "new@example.com" }, { path: "/sso/saml2/sp/acs/corp", params: { providerId: "corp" } });

      // Unknown provider, or the shared callback that carries no provider id.
      await expect(
        check({ email: "new@example.com" }, { path: "/sso/callback/other", params: { providerId: "other" } }),
      ).rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });
      await expect(check({ email: "new@example.com" }, { path: "/sso/callback" })).rejects.toMatchObject({
        body: { code: "SIGNUP_CLOSED" },
      });
    });
    expect(lookups).toEqual(["corp", "corp", "corp", "other"]);
  });

  it("leaves other user creation alone and honours AUTH_ALLOW_SIGNUP and the first account", async () => {
    let counted = 0;
    const closed = createSsoSignupCheck({
      countUsers: async () => {
        counted += 1;
        return 3;
      },
      findSsoProviderDomain: noProvider,
    });

    await withAllowSignup(undefined, async () => {
      await closed({ email: "a@gmail.com" }, { path: "/sign-up/email" });
      await closed({ email: "a@gmail.com" }, { path: "/sign-in/header" });
      await closed({ email: "a@gmail.com" }, null);
      expect(counted).toBe(0);
    });

    await withAllowSignup("true", async () => {
      await closed({ email: "a@gmail.com" }, { path: "/sso/callback/corp", params: { providerId: "corp" } });
      expect(counted).toBe(0);
    });

    const firstUser = createSsoSignupCheck({ countUsers: async () => 0, findSsoProviderDomain: noProvider });
    await withAllowSignup(undefined, () =>
      firstUser({ email: "a@gmail.com" }, { path: "/sso/callback/corp", params: { providerId: "corp" } }),
    );
  });
});
