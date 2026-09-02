import type { APIRoute } from 'astro';
import { httpGet, HttpError } from '@/lib/http-client';
import { createSecureErrorResponse } from '@/lib/utils';
import {
  DESTINATION_PROVIDER_LABELS,
  isPushDestinationKind,
  normalizeDestinationBaseUrl,
  normalizeDestinationProviderKind,
  type PushDestinationKind,
} from '@/lib/destination-kinds';
import { createPushTarget, PushTargetError } from '@/lib/push-engine/targets';

// Forgejo reports `15.0.0+gitea-1.22.0`; pure Gitea reports just `1.22.0`.
// Forgejo < 15.0.0 has a known bug where pull-mirror credentials sent via
// /api/v1/repos/migrate are not persisted, so subsequent sync of private
// repos fails with `terminal prompts disabled`. Fixed upstream in v15.0.0
// via PR #11909 (codeberg.org/forgejo/forgejo/pulls/11909).
function parseServerInfo(versionString: string) {
  const forgejoMatch = versionString.match(/^(\d+)\.(\d+)\.(\d+)\+gitea-/);
  if (forgejoMatch) {
    const major = Number(forgejoMatch[1]);
    return {
      type: 'forgejo' as const,
      version: `${forgejoMatch[1]}.${forgejoMatch[2]}.${forgejoMatch[3]}`,
      raw: versionString,
      hasMirrorCredBug: major < 15,
    };
  }
  return { type: 'gitea' as const, version: versionString, raw: versionString, hasMirrorCredBug: false };
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GitHub and GitLab destinations are push targets: the check is whether the
 * token identifies a user there, and that it belongs to the account named
 * in the form when one is given.
 */
async function testPushTarget(
  kind: PushDestinationKind,
  { url, token, username }: { url?: string; token?: string; username?: string }
): Promise<Response> {
  const label = DESTINATION_PROVIDER_LABELS[kind];
  if (!token) {
    return json({ success: false, message: `${label} token is required` }, 400);
  }

  const baseUrl = normalizeDestinationBaseUrl(url, kind);
  try {
    const target = createPushTarget(kind, { url: baseUrl, username: username || '', token });
    const identity = await target.testConnection();

    if (username && identity.login.toLowerCase() !== String(username).toLowerCase()) {
      return json({ success: false, message: `Token belongs to ${identity.login}, not ${username}` }, 400);
    }

    const version = identity.label ?? label;
    return json(
      {
        success: true,
        message: `Successfully connected to ${version} as ${identity.login}`,
        user: { login: identity.login },
        serverInfo: { type: kind, version, raw: version, hasMirrorCredBug: false },
      },
      200
    );
  } catch (error) {
    console.error(`${label} connection test failed:`, error);
    if (error instanceof PushTargetError && error.status === 401) {
      return json({ success: false, message: `Invalid ${label} token` }, 401);
    }
    if (error instanceof PushTargetError && error.status === 404) {
      return json({ success: false, message: `${label} API endpoint not found. Please check the URL.` }, 404);
    }
    return createSecureErrorResponse(error, `${label} connection test`, 500);
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { url, token, username } = body;
    const provider = normalizeDestinationProviderKind(body.provider);

    if (isPushDestinationKind(provider)) {
      return testPushTarget(provider, { url, token, username });
    }

    if (!url || !token) {
      return json({ success: false, message: 'Gitea URL and token are required' }, 400);
    }

    // Normalize the URL (remove trailing slash if present)
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    // Test the connection by fetching the authenticated user
    const response = await httpGet(`${baseUrl}/api/v1/user`, {
      'Authorization': `token ${token}`,
      'Accept': 'application/json',
    });

    const data = response.data;

    // Verify that the authenticated user matches the provided username (if provided)
    if (username && data.login !== username) {
      return json({ success: false, message: `Token belongs to ${data.login}, not ${username}` }, 400);
    }

    let serverInfo: ReturnType<typeof parseServerInfo> | undefined;
    try {
      const versionResp = await httpGet(`${baseUrl}/api/v1/version`, {
        'Accept': 'application/json',
      });
      if (typeof versionResp.data?.version === 'string') {
        serverInfo = parseServerInfo(versionResp.data.version);
      }
    } catch {
      // Version probe is best-effort; older or non-standard servers may not expose it.
    }

    return json(
      {
        success: true,
        message: `Successfully connected to Gitea as ${data.login}`,
        user: {
          login: data.login,
          name: data.full_name,
          avatar_url: data.avatar_url,
        },
        serverInfo,
      },
      200
    );
  } catch (error) {
    console.error('Gitea connection test failed:', error);

    // Handle specific error types
    if (error instanceof HttpError) {
      if (error.status === 401) {
        return json({ success: false, message: 'Invalid Gitea token' }, 401);
      } else if (error.status === 404) {
        return json({ success: false, message: 'Gitea API endpoint not found. Please check the URL.' }, 404);
      } else if (error.status === 0) {
        // Network error
        return json({ success: false, message: 'Could not connect to Gitea server. Please check the URL.' }, 500);
      }
    }

    // Generic error response
    return createSecureErrorResponse(error, "Gitea connection test", 500);
  }
};
