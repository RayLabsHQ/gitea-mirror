# MCP

Gitea Mirror exposes an OAuth-protected HTTP Streamable MCP endpoint at `/api/mcp`. All tools are bound to the OAuth user's account; callers cannot supply a `userId`. The service uses Better Auth OAuth 2.1 and the protected-resource metadata advertises supported scopes.

## Authorization

Use the deployment's public endpoint (including `BASE_URL`, if configured), OAuth authorization-code flow with PKCE, and the MCP endpoint as the resource/audience. Request only what is needed:

- `mirror:read`: read repositories, organizations, activities, mirror configuration and previews.
- `mirror:sync`: queue repository sync/retry, imports, metadata refresh, bulk/organization jobs, mirror moves, alert resolution and destination reconciliation.
- `mirror:settings`: update repository/organization mirror settings and allowlisted automation/global mirror options. Record deletion requires explicit confirmation.

For production, configure `BETTER_AUTH_URL` to the externally reachable authentication origin and serve over TLS. Reverse proxies must forward the public HTTPS origin correctly.

## Implemented tools

### `mirror:read`

`list_repositories`, `get_repository_status`, `get_repository`, `preview_tracked_repositories`, `preview_repository_releases`, `list_organizations`, `get_organization`, `preview_organization_repositories`, `get_organization_mirror_overrides`, `export_repositories`, `export_organizations`, `get_dashboard_summary`, `list_activities`, `get_provider_rate_limit`, `list_starred_lists`, `preview_organization_mirror_move`, and `get_mirror_configuration`.

Read tools return selected user-facing fields, not complete database rows; repository source URLs, clone URLs, destination endpoints, internal IDs on exports, and secrets are excluded. Configuration reads expose only an allowlist of non-secret mirror and schedule options. Activity filters verify ownership of any selected repository or organization before querying. `preview_tracked_repositories` and `preview_organization_repositories` list already-tracked candidates, with organization previews constrained to the organization's pinned source (or unpinned rows). There is currently no connected-source discovery endpoint, so MCP does not claim to preview untracked source repositories. `preview_repository_releases` reads destination releases but does not simulate configured release include/exclude rules. Organization move preview is an estimate, not a transfer guarantee.

### `mirror:sync`

- `sync_repository(repositoryId)`
- `retry_repository_sync(repositoryId)`
- `import_repository(owner, repo, host?, path?, destinationOrg?, confirm?)`; `confirm: true` uses the source route's force/refresh branch after a duplicate response.
- `import_organization(org, sourceId?, provider?, sourceUrl?, confirm?)`; `confirm: true` uses the duplicate force branch while retaining provider/source rules.
- `refresh_repository_metadata(repositoryId, confirm: true)`: derives source identity from the owned record.
- `sync_repositories(repositoryIds)`, `mirror_repositories(repositoryIds)` (up to 25)
- `sync_organization(organizationId)`, `mirror_organization(organizationId)`
- `reset_repository_metadata(repositoryIds, confirm: true)`
- `resolve_sync_alert(repositoryIds, action, confirm: true)`
- `move_repository_mirror(repositoryId, destinationOwner, confirm: true)`
- `move_organization_mirrors(organizationId, destinationOrg, dryRun, confirm?)`
- `reconcile_destination(dryRun, adoptUntracked, resetMissing, relocateMoved, confirm?)`
- `set_organization_status_with_cascade(organizationId, status, cascade)`

Dispatch uses an explicit operation allowlist and invokes existing route handlers with the authenticated user session. Batch inputs are capped at 25; targets are checked before dispatch, and route ownership checks remain active. Destructive/applying actions require confirmation. Results intentionally omit route database rows and secrets. A successful response means accepted/enqueued where applicable, not completed; check status/activity afterward.

### `mirror:settings`

- `set_repository_status(repositoryId, status)`: `imported` or `ignored`.
- `update_repository_settings(repositoryId, destinationOrg?)`: change the repository destination override; this does not move an existing mirror.
- `update_repository_mirror_overrides(repositoryId, mirrorOverrides)`.
- `delete_repositories(repositoryIds, confirm: true)`: invokes the application's repository cleanup route, including activity-row cleanup and pushed-clone cleanup where applicable.
- `delete_organization(organizationId, confirm: true)`: invokes the application's ownership-checked route and repository cascade.
- `update_organization_mirror_overrides(organizationId, mirrorOverrides)`.
- `set_organization_destination(organizationId, destinationOrg)`.
- `set_organization_source(organizationId, sourceId)`, where a non-null source must belong to the caller.
- `update_mirror_configuration(mirrorOptions)`: strict allowlist covering mirror interval, LFS/wiki, visibility and organization creation, topic handling, preservation/fork strategy, issue/review concurrency, release switches/limits/type/tag patterns, and metadata switches. Visibility is `public|private|limited|default`, fork strategy `skip|reference|full-copy`, and release type `all|stable`. Release limits are integers 0–1000; concurrency is 1–100. URL/token, username, backup settings/paths and cleanup policies are not accepted.
- `update_schedule_configuration(schedule)`: strict fields only (`enabled`, `interval`, `timezone`, `autoImport`, `autoMirror`). `interval` is a bounded non-empty string matching the stored schedule schema (cron expressions and legacy duration strings); numeric intervals and operational/cleanup controls are rejected.

## Not exposed

Cleanup policy writes remain excluded because they can automatically delete destination data. Credentials, source/destination URLs and tokens, notification endpoints/secrets, login/signup/password/email/SSO/OAuth administration, API-key and credential management/testing, SSE, activity cleanup, and broad operator cleanup remain excluded.
