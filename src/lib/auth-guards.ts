import type { APIContext } from "astro";
import { auth } from "@/lib/auth";

function unauthorizedResponse() {
  return new Response(
    JSON.stringify({
      success: false,
      error: "Unauthorized",
    }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Ensures request is authenticated and returns the authenticated user ID.
 * Never trust client-provided userId for authorization decisions.
 */
export async function requireAuthenticatedUserId(
  context: Pick<APIContext, "request" | "locals">
): Promise<{ userId: string } | { response: Response }> {
  const localUserId =
    context.locals?.session?.userId || context.locals?.user?.id;

  if (localUserId) {
    return { userId: localUserId };
  }

  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  try {
    session = await auth.api.getSession({
      headers: context.request.headers,
    });
  } catch {
    return { response: unauthorizedResponse() };
  }

  if (!session?.user?.id) {
    return { response: unauthorizedResponse() };
  }

  return { userId: session.user.id };
}
