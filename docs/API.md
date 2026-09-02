# API access with API keys

Gitea Mirror's web UI talks to a set of JSON endpoints under `/api`. With an API key you can call the same endpoints from scripts, CI pipelines and workflow tools such as n8n, without a browser session.

## Create a key

1. Sign in and open **Settings → Authentication**.
2. In the **API Keys** section click **Create key**, give it a name and pick an expiry (never, 30 days, 90 days or a year).
3. Copy the key. It is shown once; afterwards only its first characters are visible in the list.

Keys start with `gm_`, belong to the user who created them and carry the same rights as that user's session. Revoke a key from the same list at any time. Keys are stored hashed. They are not rate limited, so a runaway script is stopped by revoking its key.

## Send the key

Put the key in the `x-api-key` header. Every endpoint that accepts a session cookie accepts the header instead.

```bash
curl -sS "https://mirror.example.com/api/github/repositories" \
  -H "x-api-key: gm_..."
```

A missing, malformed, expired or revoked key gets `401 Unauthorized`:

```json
{ "success": false, "error": "Unauthorized" }
```

If the app is served under a base path (`BASE_PATH=/mirror`), prefix every URL with it: `/mirror/api/...`.

## Endpoints

The calls below cover the automation cases from issue #314. Response bodies show the fields you are most likely to use; the app returns more.

### List tracked repositories

`GET /api/github/repositories`

Despite the name it lists every repository the account tracks, whatever the configured source. Requires a saved configuration, otherwise `404`.

```json
{
  "success": true,
  "message": "Repositories fetched successfully",
  "repositories": [
    {
      "id": "9b2f...",
      "name": "hello-world",
      "fullName": "octocat/hello-world",
      "owner": "octocat",
      "organization": null,
      "status": "mirrored",
      "mirroredLocation": "github-mirrors/hello-world",
      "lastMirrored": "2026-09-02T08:00:00.000Z",
      "errorMessage": null,
      "destinationOrg": null,
      "sourceProvider": "github",
      "isPrivate": false
    }
  ]
}
```

`status` is one of `imported`, `mirroring`, `mirrored`, `failed`, `syncing`, `synced`, `skipped`, `deleted`, `archived`.

### Add a repository

`POST /api/sync/repository`

```json
{ "owner": "octocat", "repo": "hello-world" }
```

Optional fields: `destinationOrg` to override the Gitea organization for this repository, `force: true` to refresh the metadata of a repository that is already tracked.

The repository is looked up on the configured source and added with status `imported`. It is not mirrored until you start a mirror (next call) or the scheduler picks it up.

| Status | Meaning |
| --- | --- |
| `200` | Added. `repository.id` is what the mirror call needs. |
| `400` | `owner` or `repo` missing. |
| `404` | No configuration for this account, or the repository does not exist on the source. |
| `409` | Already tracked. Send `force: true` to refresh it instead. |

```json
{
  "success": true,
  "message": "Repository added successfully",
  "repository": { "id": "9b2f...", "fullName": "octocat/hello-world", "status": "imported" }
}
```

### Start a mirror

`POST /api/job/mirror-repo`

```json
{ "repositoryIds": ["9b2f..."] }
```

Starts mirroring in the background and returns straight away. Poll the list endpoint to watch `status` move from `mirroring` to `mirrored` or `failed`.

| Status | Meaning |
| --- | --- |
| `200` | Job started. `repositories` lists what was queued. |
| `400` | `repositoryIds` missing or empty, or no source token saved. |
| `404` | None of the ids belong to this account. |

`POST /api/job/sync-repo` takes the same body and re-syncs repositories that are already mirrored.

### Organizations

`POST /api/sync/organization` adds an organization the same way:

```json
{ "org": "my-org", "role": "member" }
```

`role` is the account's role in that organization (`member`, `admin`, `owner` or `billing_manager`). `409` means it is already tracked; `force: true` refreshes it. Then `POST /api/job/mirror-org` with `{ "organizationIds": ["..."] }` mirrors its repositories.

### Reconcile the destination

`POST /api/cleanup/reconcile`

Compares what the destination (Gitea or Forgejo) holds with the repositories this account tracks, and reports three groups: mirrors on the destination that the database does not know about, rows marked mirrored whose repository is gone, and a healthy count. Only mirrors whose source URL points at the configured source count as this app's. Native repositories and mirrors of other hosts are listed under `notManaged` and never touched. Useful after a lost or restored database (issue #284).

```json
{ "dryRun": true, "adoptUntracked": false, "resetMissing": false }
```

The body is optional and every field defaults to the value above, so an empty `POST` is a dry run. With `dryRun: false`:

- `adoptUntracked: true` creates a row for each untracked mirror from its source URL, so scheduled sync and the cleanup service include it from then on. The row keeps the mirror where it is, even when the strategy would put it elsewhere.
- `resetMissing: true` sets each missing row back to `imported` so the next mirror run recreates the mirror. Rows are never deleted.

Nothing is deleted or archived on either side by this call; the cleanup service keeps its own rules.

```json
{
  "success": true,
  "dryRun": false,
  "report": {
    "untracked": [{ "location": "github-mirrors/hello-world", "originalUrl": "https://github.com/octocat/hello-world.git", "sourcePath": "octocat/hello-world", "isPrivate": false }],
    "missing": [{ "id": "9b2f...", "fullName": "octocat/gone", "location": "github-mirrors/gone" }],
    "notManaged": [{ "location": "me/notes", "reason": "not a mirror" }],
    "unverified": [],
    "healthyCount": 41,
    "elsewhereCount": 0,
    "scannedOwners": ["e2e_admin", "github-mirrors"],
    "skippedOwners": ["starred"],
    "totalOnDestination": 43
  },
  "applied": { "adopted": 1, "reset": 1, "skipped": 0 }
}
```

`applied` is `null` on a dry run. `scannedOwners` are the destination users and organizations that were listed; `skippedOwners` are ones the configuration or the database point at but the destination does not have. A row lands in `unverified` when the presence check itself failed, and is left alone.

| Status | Meaning |
| --- | --- |
| `200` | Report computed, and applied when asked. |
| `400` | A field has the wrong type, or the destination is not configured yet. |
| `404` | No configuration for this account. |

## A complete example

Add a repository and mirror it in one go:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="https://mirror.example.com"
KEY="gm_..."

added=$(curl -sS -X POST "$BASE/api/sync/repository" \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"owner":"octocat","repo":"hello-world"}')

id=$(echo "$added" | jq -r '.repository.id')

curl -sS -X POST "$BASE/api/job/mirror-repo" \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"repositoryIds\":[\"$id\"]}"
```

## Managing keys from the API

Manage keys through the settings UI or with a browser session. The key endpoints need a session cookie, not a key, so a leaked key cannot mint more keys, and like every cookie-authenticated `POST` to `/api/auth/*` they also need an `Origin` header (browsers send it on their own; a script must add `Origin: https://mirror.example.com`). The key itself is only for the app routes above. The endpoints live under `/api/auth/api-key/`:

| Call | Body | Result |
| --- | --- | --- |
| `POST /api/auth/api-key/create` | `{ "name": "ci", "expiresIn": 2592000 }` (`expiresIn` in seconds, omit for no expiry) | The new key, including `key`, shown only here. |
| `GET /api/auth/api-key/list` | | `{ "apiKeys": [...], "total": n }`. Each entry has `id`, `name`, `start`, `createdAt`, `lastRequest` and `expiresAt`, never the secret. |
| `POST /api/auth/api-key/delete` | `{ "keyId": "..." }` | Revokes the key. |

## Notes

- A key can only act on the account that created it. Each account keeps its own source, destination and repositories.
- Keys are not rate limited by the app. Source hosts still apply their own limits, and the app tracks GitHub's.
- Deleting a user deletes their keys.
