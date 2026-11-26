import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { OWNER_ONLY_CODE, OWNER_ONLY_MESSAGE } from "@/lib/instance-owner";

/**
 * Keeps the SSO plugin's provider management for the instance owner (the
 * first account), the same rule the app's own SSO routes follow
 * (GHSA-c6c2-hr73-h7hw).
 *
 * The app registers providers through POST /api/auth/sso/register, its own
 * Astro route, which shadows the plugin's endpoint of that name. The
 * plugin's other management endpoints are still served by the
 * /api/auth/[...all] catch-all, so the check has to happen here as well.
 * Calls the app makes through auth.api.* pass the caller's headers and run
 * through this hook too.
 *
 * Sign-in and callback endpoints are not listed: anyone may sign in.
 */
export const OWNER_ONLY_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/get-provider",
  "/sso/providers",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
]);

export function isOwnerOnlyAuthPath(path: string | undefined): boolean {
  return typeof path === "string" && OWNER_ONLY_AUTH_PATHS.has(path);
}

export function ownerOnlyError(): APIError {
  return new APIError("FORBIDDEN", { message: OWNER_ONLY_MESSAGE, code: OWNER_ONLY_CODE });
}

type OwnerGuardOptions = {
  isOwner: (userId: string) => Promise<boolean>;
};

export const ownerGuardPlugin = (options: OwnerGuardOptions) =>
  ({
    id: "owner-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => isOwnerOnlyAuthPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session?.user?.id || !(await options.isOwner(session.user.id))) {
              throw ownerOnlyError();
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
