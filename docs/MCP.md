# MCP

Gitea Mirror provides an **HTTP Streamable MCP** endpoint at `/api/mcp` for MCP clients. The endpoint uses the application's Better Auth OAuth 2.1 integration and requires an authenticated user. Tool access is scoped to that user's repositories and activity; clients do not pass a `userId` parameter.

## Connect a client

Configure your MCP client using the deployment's public origin and these conceptual steps:

1. Connect to the MCP endpoint at `https://mirror.example.com/api/mcp` (replace the origin with your deployment's). If the app is mounted under `BASE_URL`, include that prefix; for example, `BASE_URL=/mirror` makes the path `/mirror/api/mcp`.
2. Register an OAuth client using dynamic client registration, if supported by the client and deployment.
3. Authorize with the OAuth 2.1 authorization-code flow and PKCE.
4. Use the MCP endpoint as the protected resource/audience, and request the scopes needed: `mirror:read` for read tools and `mirror:sync` for sync/retry tools.
5. Complete authorization and let the client send its access token when connecting to the MCP endpoint.

The exact OAuth discovery and registration URLs are not specified here; use the OAuth metadata exposed by the deployment/client integration rather than assuming particular well-known paths. OAuth is handled by the existing Better Auth setup.

For production, configure `BETTER_AUTH_URL` to the externally reachable authentication origin (scheme and host, without a path), and serve the app over TLS. Ensure any reverse proxy forwards the public HTTPS origin correctly. Incorrect public auth URLs or missing TLS can break secure OAuth redirects and token flows. See [environment variables](./ENVIRONMENT_VARIABLES.md) for auth URL configuration.

## Available tools

| Tool | Purpose | Scope |
| --- | --- | --- |
| `list_repositories` | List the authenticated user's repositories, optionally filtered by status (up to 100 results). | `mirror:read` |
| `get_repository_status` | Get one repository's status and recent activity. | `mirror:read` |
| `list_activities` | List recent mirror and sync activity for the authenticated user (up to 100 results). | `mirror:read` |
| `sync_repository` | Queue a sync for one of the authenticated user's repositories. | `mirror:sync` |
| `retry_repository_sync` | Queue a retry for one of the authenticated user's repositories. | `mirror:sync` |

Sync and retry tools enqueue work asynchronously; a successful response means the request was accepted, not that mirroring has finished. Use the read tools to check repository status and activity afterward. Repository IDs identify the target; ownership is resolved from the authenticated account, not a client-supplied user ID.
