import { describe, expect, test } from "bun:test";
import { APIError } from "better-auth/api";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOwnerOnlyAuthPath, oauthClientPrivileges, ownerGuardPlugin, ownerOnlyError } from "./auth-owner-guard";

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

describe("oauthClientPrivileges", () => {
  const check = oauthClientPrivileges({ isOwner: async (userId) => userId === "owner" });
  const managing = ["create", "read", "list", "update", "delete", "rotate"] as const;

  test("the owner may create, register, read, list, change, delete and rotate", async () => {
    for (const action of managing) {
      expect([action, await check({ action, user: { id: "owner" } })]).toEqual([action, true]);
    }
  });

  test("anyone else is refused with OWNER_ONLY, so a member cannot make an application to phish approvals", async () => {
    for (const action of managing) {
      const error = await check({ action, user: { id: "member" } }).catch((e) => e);
      expect([action, error instanceof APIError, error?.body?.code]).toEqual([action, true, "OWNER_ONLY"]);
    }
    const anonymous = await check({ action: "create", user: undefined }).catch((e) => e);
    expect(anonymous?.body?.code).toBe("OWNER_ONLY");
  });

  test("client credentials scopes stay off, even for the owner, as before", async () => {
    expect(await check({ action: "configure-client-credentials-scopes", user: { id: "owner" } })).toBe(false);
  });

  test("auth.ts hands it to the OAuth provider plugin", () => {
    const source = readFileSync(join(import.meta.dir, "auth.ts"), "utf8");
    expect(source).toContain("clientPrivileges: oauthClientPrivileges(");
  });
});
