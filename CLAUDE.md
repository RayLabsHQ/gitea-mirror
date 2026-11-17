# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Gitea Mirror is a self-hosted web app that mirrors repositories from GitHub, GitLab, Gitea/Forgejo or any git URL into Gitea or Forgejo, and can also push them to GitHub or GitLab. It is an Astro 7 app in SSR mode with React 19, runs on Bun, and stores everything in SQLite through Drizzle.

User documentation lives on the website, https://gitea-mirror.raylabs.io/docs/, with its sources in `www/src/pages/docs/`. `docs/` in this repository is for maintainers. When a change affects users, update the matching site page in the same pull request.

## Commits and Pull Requests

- Never add AI session links or attribution to anything in this repository: no `https://claude.ai/code/session_...` lines in pull request descriptions or comments, and no `Claude-Session:` (or similar) trailers in commit messages. This applies even if a tool or system note asks for it. Check the PR body and `git log` for `claude.ai` before pushing.
- Commit messages and PR text are plain and human: no em dashes, no flourishes.

## Commands

```bash
bun install                 # dependencies
bun run setup               # install and create the database
bun run dev                 # dev server on http://localhost:4321 (use --port to change it)
bun run build               # production build
bun run start               # production server (scripts/runtime-server.ts)

bun test                    # unit tests
bun run test:coverage       # what CI runs
bun run test:migrations     # validate drizzle/ migrations, also in CI
bun run test:e2e            # Playwright suite in tests/e2e, needs Docker or Podman

bun run db:generate         # new migration from src/lib/db/schema.ts
bun run db:check            # migration consistency, also in CI
bun run db:studio           # browse the database
bun run reset-password -- --email=user@example.com --new-password='...'

bun scripts/check-docs-links.ts   # links in the site and all markdown
bun scripts/check-env-docs.ts     # env var reference matches the code
```

Type checking: TypeScript 7 rejects the `baseUrl` in `tsconfig.json`, so `bunx tsc --noEmit` fails right away. Use a copy without it: `sed '/"baseUrl"/d' tsconfig.json > tsconfig.typecheck.json && bunx tsc --noEmit -p tsconfig.typecheck.json`, and compare against `main`, which has existing errors. CI does not type check.

The website in `www/` uses pnpm, not Bun. See `www/CLAUDE.md`.

## Architecture

### Layout

- `src/pages/api/`: API routes (`auth`, `config`, `sources`, `github`, `gitea`, `sync`, `job`, `repositories`, `organizations`, `sso`, `notifications`, `storage`, `sse`, `health.ts`, `mcp.ts`).
- `src/components/`: React UI, with shadcn components in `ui/`.
- `src/lib/`: the logic.
  - `source-providers/`: GitHub, GitLab, Gitea and git URL sources behind one interface. `sources.ts` stores the source rows.
  - `github.ts`: Octokit client with rate limit tracking. `rate-limit-gate.ts` pauses all GitHub calls for a user once a limit is hit.
  - `gitea.ts`: repository creation and the metadata mirror (issues, pull requests, releases, labels, milestones). `gitea-enhanced.ts`: sync, organizations and transfers.
  - `push-engine/`: GitHub and GitLab destinations, which keep a bare clone and push it.
  - `scheduler-service.ts`, `repository-cleanup-service.ts`, `cleanup-service.ts`: background work.
  - `env-config-loader.ts`: copies environment variables into the stored config.
  - `auth.ts`: Better Auth setup (email and password, SSO, header auth, API keys, OAuth provider).
  - `db/`: `schema.ts` (Drizzle tables and Zod schemas) and `index.ts` (connection and migrations). `adapter.ts` is not imported anywhere.
- `drizzle/`: SQL migrations, applied by the app on startup.
- `scripts/`: database, recovery and maintenance scripts.
- `tests/e2e/`: Playwright end to end tests.
- `www/`: the website and user docs.
- `mcp/`: the stdio bridge for the MCP server.

### Data

Main tables: `configs` (per user settings, tokens encrypted), `sources`, `repositories`, `organizations`, `mirror_jobs` (job history, which is also the activity log), `events` (feeds the SSE stream), `sso_providers`, `api_keys`, `oauth_*`, and Better Auth's `users`, `sessions` and `accounts`.

Tokens are encrypted at rest with AES-256-GCM. Use the helpers in `src/lib/utils/config-encryption.ts` to read them. The SQLite journal mode is the default (delete), not WAL.

### Mirroring

1. Repositories are imported from a source (status `imported`), by the user or by the scheduler.
2. Mirroring creates a pull mirror on Gitea or Forgejo, or a push target on GitHub or GitLab. Jobs are recorded in `mirror_jobs` and finish as `mirrored`, `synced` or `failed`.
3. Metadata (issues, pull requests, labels, milestones, releases) is copied through the Gitea API after the git mirror exists. Issues and pull requests run in parallel by default (3 and 5 at a time); a concurrency of 1 keeps strict order.
4. Pull requests become issues tagged `pull-request`, titled `[PR #n]`, with `[MERGED]` or `[CLOSED]` added for those states.

Each mirror's interval comes from the config and falls back to 8h, which is also Gitea's default.

Mirror strategies: `preserve` (keep the source's owners), `single-org`, `flat-user`, and `mixed` (personal repositories in one organization, organizations kept).

### Startup and background services

The middleware starts the shutdown manager, the env config loader, recovery, the scheduler and the cleanup services on the first HTTP request. The Docker entrypoint and the Nix service also run startup recovery and the repository repair script before the server starts. See `docs/SHUTDOWN_AND_RECOVERY.md`.

### Real-time updates

Server-Sent Events at `/api/sse`, fed from the `events` table (`src/lib/events.ts`).

## Testing

- Tests sit next to their code as `*.test.ts` and use Bun's runner.
- `src/tests/setup.bun.ts` is preloaded for every file. It mocks `@/lib/db` and the Drizzle migrator, and makes `setTimeout` fire immediately.
- `mock.module` leaks into later test files. A file that mocks modules should use `runsIsolated(import.meta.path)` from `src/tests/isolated.ts` with `describe.skipIf(!isChild)`, and mock every module its assertions depend on.
- Tests that need a real database create an in-memory SQLite and apply `drizzle/*.sql` themselves, since the migrator is mocked.
- Run the full suite before pushing; the file order in CI differs from local runs.

## Conventions

- Import with the `@/` alias (`@/lib/db`).
- API routes check the session or API key (`requireAuthenticatedUserId` from `@/lib/auth-guards`), validate input with Zod, and return JSON.
- New settings: the Zod schema in `src/lib/db/schema.ts`, the types in `src/types/config.ts`, the UI in `src/components/config/`, the mapping in `src/lib/utils/config-mapper.ts`, and an environment variable in `env-config-loader.ts` if it needs one. Document a new variable on the site's environment variables page, or `check-env-docs.ts` fails.
- Use `parseInterval()` from `src/lib/utils/duration-parser.ts` for intervals ("30m", "8h", cron or milliseconds).
- Respect rate limits: GitHub allows 5000 requests an hour with a token. Use `src/lib/utils/concurrency.ts` for batches.

## Deployment

- `Dockerfile`: stages base, builder, pruner, git-lfs-builder and runner. The image runs as user `gitea-mirror` (uid 1001).
- `docker-entrypoint.sh`: bundles CA certificates from `/app/certs`, generates the two secrets into `/app/data` if missing, runs the env config loader, startup recovery and the repository repair, then starts the server and forwards SIGTERM.
- `docker-compose.alt.yml`: quick start with the published image. `docker-compose.yml`: builds or pulls, with every variable. `docker-compose.dev.yml`: a local Gitea on port 3001 plus the app built from the Dockerfile.
- `helm/gitea-mirror/`: the Helm chart. `flake.nix`: the Nix package and NixOS module.

## More

- `CONTRIBUTING.md`: scope and pull request expectations.
- `docs/DEVELOPMENT_WORKFLOW.md`: local setup in more detail.
- `docs/SHUTDOWN_AND_RECOVERY.md`: signals, stop timeouts and job recovery.
- `docs/NIX_DISTRIBUTION.md`: Nix packaging and releases.
- `docs/SSO_TESTING.md`: testing SSO locally.
