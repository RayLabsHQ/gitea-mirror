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

type OAuthClientAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "list"
  | "rotate"
  | "configure-client-credentials-scopes";

/**
 * The OAuth provider plugin's clientPrivileges check: only the instance owner
 * creates, registers, reads, lists, changes, deletes or rotates the secret of
 * an OAuth application, whether through the plugin's endpoints under
 * /api/auth/oauth2/* or through auth.api.* calls the app makes.
 *
 * An application can ask anyone on this instance to approve it. One made by
 * another account, with a familiar name and its own redirect address, would
 * show the real consent page on the real domain, and an approval would hand
 * that account a token for the approver's account. Signing in to an
 * application and managing one's own approvals stay open to everyone; those
 * endpoints do not go through this check.
 *
 * configure-client-credentials-scopes stays refused, as it was before this
 * check existed: the plugin only allows it when clientPrivileges says so.
 */
export function oauthClientPrivileges(options: OwnerGuardOptions) {
  return async ({ action, user }: { action: OAuthClientAction; user?: { id?: string } }) => {
    if (action === "configure-client-credentials-scopes") return false;
    if (!user?.id || !(await options.isOwner(user.id))) throw ownerOnlyError();
    return true;
  };
}
