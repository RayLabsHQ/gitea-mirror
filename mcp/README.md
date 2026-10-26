# gitea-mirror-mcp

Connects AI assistants to [Gitea Mirror](https://github.com/RayLabsHQ/gitea-mirror) through [MCP](https://modelcontextprotocol.io), so Claude, Cursor or any other MCP client can check on your mirrors, find failures, add repositories and organizations, and start syncs and retries.

The tools live in Gitea Mirror itself, at `/api/mcp`, and act through its REST API with an API key. There are two ways in:

- **Over HTTP**, for clients that can send a header with a remote server (Claude Code): point them at `https://mirror.example.com/api/mcp` with the key in `x-api-key`. Nothing to install.
- **Through this package**, for clients that start a local command (Claude Desktop, Cursor): `gitea-mirror-mcp` passes each message to the endpoint and the answer back. It has no dependencies.

## Requirements

- Gitea Mirror 3.46.0 or later.
- An API key. In Gitea Mirror open the Configuration page, the **Authentication** tab, then **Create key** in the **API Keys** card.
- Node.js 20 or later, only for this package.

Pick the key's access with care. The assistant can do whatever the key allows:

- **Read only**: the assistant can list and inspect, nothing else. Every tool that changes something gets a clear refusal.
- **Full access**: the assistant can also add repositories and organizations and start mirrors, syncs and retries. None of the tools delete, archive or change settings, but the key itself can do anything your account can do through the API, so keep it out of shared config files.

## Setup

### Claude Code

```bash
claude mcp add --transport http gitea-mirror https://mirror.example.com/api/mcp \
  --header "x-api-key: gm_..."
```

### Claude Desktop, Cursor and other clients

Add the server to the client's MCP config (`claude_desktop_config.json` for Claude Desktop, `~/.cursor/mcp.json` for Cursor):

```json
{
  "mcpServers": {
    "gitea-mirror": {
      "command": "npx",
      "args": ["-y", "gitea-mirror-mcp"],
      "env": {
        "GITEA_MIRROR_URL": "https://mirror.example.com",
        "GITEA_MIRROR_API_KEY": "gm_..."
      }
    }
  }
}
```

| Variable | Value |
| --- | --- |
| `GITEA_MIRROR_URL` | The address you open in the browser, for example `https://mirror.example.com`. Include the path prefix if the app runs under one (`https://example.com/mirror`). |
| `GITEA_MIRROR_API_KEY` | The `gm_...` key. |

A client that supports remote servers with custom headers can skip the package and use the URL directly, like Claude Code above.

### From a checkout

```bash
cd mcp
npm ci
npm run build   # needs Bun
```

Then use `node /path/to/gitea-mirror/mcp/dist/index.js` as the command instead of `npx -y gitea-mirror-mcp`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_repositories` | Tracked repositories with their status, newest first. Filter by `status` or `search` on owner/name; `limit` up to 200. |
| `get_repository` | One repository by id or owner/name: status, where it is mirrored to, the last error and its recent activity. |
| `list_failures` | Repositories whose last mirror or sync failed, with the error. |
| `list_organizations` | Tracked organizations with their status and repository count. |
| `add_repository` | Track a repository from a browser, clone or SSH URL (or `owner/name` for the default source) and start mirroring it. Optional `destinationOrg`; `mirror: false` only tracks it. Adding one that is already tracked returns it. |
| `add_organization` | Track an organization and its repositories and start mirroring them. `mirror: false` only tracks it. |
| `sync_repositories` | Pull the latest changes into repositories that are already mirrored (up to 50 ids). |
| `retry_repositories` | Retry failed repositories, or start ones that were added but never mirrored (up to 50 ids). |

The first four only read. Mirrors, syncs and retries run in the background in Gitea Mirror; the tool returns once the job has started, so ask the assistant to check `get_repository` or `list_failures` afterwards.

Things you might ask:

- "Which of my mirrors are failing, and why?"
- "Mirror https://github.com/octocat/hello-world into the archive org."
- "Retry everything that failed with a timeout."
- "When did octocat/hello-world last sync?"

## Notes

- The tools call the app's REST API from inside the app, at the address it listens on (`HOST` and `PORT`, under `BASE_URL`). If that address is not reachable from the app itself, set `MCP_INTERNAL_URL` on the server, for example `http://127.0.0.1:4321`.
- Repository names, error messages and activity text come from your source and destination hosts. The server tells the assistant to treat them as data, but review what an assistant proposes before it acts on a full access key.
- This package logs to stderr only and never prints the key.
- Anything the tools do not cover is available through the [REST API](https://github.com/RayLabsHQ/gitea-mirror/blob/main/docs/API.md) with the same key.

## License

AGPL-3.0, like Gitea Mirror.
