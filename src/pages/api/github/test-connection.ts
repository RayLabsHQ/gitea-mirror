import type { APIRoute } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import {
  SOURCE_PROVIDER_LABELS,
  createSourceProvider,
  isSourceNotFound,
  normalizeSourceProviderKind,
  normalizeSourceUrl,
} from "@/lib/source-providers";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Test a source connection. The route keeps its /github/ path for
 * compatibility, but serves every source provider: the body carries the
 * provider and, for GitLab and Gitea, the instance URL.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const { token, username, provider: rawProvider, url } = body ?? {};
  const provider = normalizeSourceProviderKind(rawProvider);
  const label = SOURCE_PROVIDER_LABELS[provider];

  try {
    if (!token) {
      return json({ success: false, message: `${label} token is required` }, 400);
    }

    // GitHub honors GH_API_URL / GITHUB_API_URL for GHES / GHEC inside the adapter.
    const sourceProvider = createSourceProvider({
      provider,
      url: normalizeSourceUrl(url, provider),
      username: typeof username === "string" ? username : "",
      token,
    });

    const account = await sourceProvider.testConnection();

    // Verify that the authenticated user matches the provided username (if provided)
    if (username && account.login !== username) {
      return json(
        { success: false, message: `Token belongs to ${account.login}, not ${username}` },
        400
      );
    }

    return json(
      {
        success: true,
        message: `Successfully connected to ${label} as ${account.login}`,
        user: {
          login: account.login,
          name: account.name ?? null,
          avatar_url: account.avatarUrl ?? null,
        },
      },
      200
    );
  } catch (error) {
    console.error(`${label} connection test failed:`, error);

    const status =
      error && typeof error === "object" && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;

    if (status === 401 || status === 403) {
      return json({ success: false, message: `Invalid ${label} token` }, 401);
    }

    if (isSourceNotFound(error)) {
      return json(
        { success: false, message: `${label} API endpoint not found. Please check the instance URL.` },
        404
      );
    }

    return createSecureErrorResponse(error, `${label} connection test`, 500);
  }
};
