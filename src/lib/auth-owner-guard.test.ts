import { describe, expect, test } from "bun:test";
import { APIError } from "better-auth/api";
import { isOwnerOnlyAuthPath, ownerGuardPlugin, ownerOnlyError } from "./auth-owner-guard";

describe("ownerGuardPlugin (GHSA-c6c2-hr73-h7hw)", () => {
  test("guards every provider management endpoint of the SSO plugin", () => {
    for (const path of [
      "/sso/register",
      "/sso/update-provider",
      "/sso/delete-provider",
      "/sso/get-provider",
      "/sso/providers",
      "/sso/request-domain-verification",
      "/sso/verify-domain",
    ]) {
      expect([path, isOwnerOnlyAuthPath(path)]).toEqual([path, true]);
    }
  });

  test("leaves sign-in, callbacks and everything else alone", () => {
    for (const path of [
      "/sign-in/sso",
      "/sso/callback/company-idp",
      "/sso/callback",
      "/sso/saml2/sp/acs/company-idp",
      "/sso/saml2/sp/metadata",
      "/get-session",
      "/sign-in/email",
      undefined,
    ]) {
      expect([path, isOwnerOnlyAuthPath(path)]).toEqual([path, false]);
    }
  });

  test("registers one before hook whose matcher uses that list", () => {
    const plugin = ownerGuardPlugin({ isOwner: async () => true });
    expect(plugin.id).toBe("owner-guard");
    expect(plugin.hooks.before).toHaveLength(1);
    const [hook] = plugin.hooks.before;
    expect(hook.matcher({ path: "/sso/update-provider" } as any)).toBe(true);
    expect(hook.matcher({ path: "/sign-in/sso" } as any)).toBe(false);
  });

  test("refuses with a 403 and a stable code", () => {
    const error = ownerOnlyError();
    expect(error).toBeInstanceOf(APIError);
    expect(error.status).toBe("FORBIDDEN");
    expect(error.body?.code).toBe("OWNER_ONLY");
    expect(error.message).toContain("first account");
  });
});
