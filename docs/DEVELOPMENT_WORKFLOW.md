# Development workflow

Local setup and day to day work on Gitea Mirror. [CLAUDE.md](../CLAUDE.md) has a map of the code, and [CONTRIBUTING.md](../CONTRIBUTING.md) covers what a pull request needs.

## Prerequisites

- Bun 1.2.9 or later. The app runs on Bun only.
- Git.
- A source account and a Gitea or Forgejo instance to test against. `docker-compose.dev.yml` starts a local Gitea on port 3001.
- For the end to end tests only: Docker or Podman with compose, and Node 22 (what CI uses for Playwright).

## Setup

```bash
git clone https://github.com/RayLabsHQ/gitea-mirror.git
cd gitea-mirror
bun run setup      # install dependencies and create data/gitea-mirror.db
bun run dev        # http://localhost:4321
```

A `.env` file is optional; copy `.env.example` to preset settings. Without `BETTER_AUTH_SECRET`, development uses a known insecure value, which is fine locally.

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Astro dev server with hot reload. Change the port with `bun run dev --port 3001`; `PORT` is ignored here. |
| `bun run dev:clean` | Delete the database, create it again and start the dev server. |
| `bun run build` | Production build into `dist/`. |
| `bun run start` | Run the production build, the way the Docker image does. |
| `bun test` | Unit tests. `bun test path/to/file.test.ts` runs one file. |
| `bun run test:coverage` | Unit tests with coverage, as in CI. |
| `bun run test:migrations` | Validate the migrations in `drizzle/`. |
| `bun run test:e2e` | Playwright suite in `tests/e2e/`, against containers it starts. |
| `bun run db:studio` | Browse the database in Drizzle Studio. |
| `bun run manage-db check` | Check the database. `init`, `fix`, `reset-users`, `reset-password` and `disable-2fa` are the other commands. |

Some things only show up in a production build, such as hydration or navigation problems that the dev server's hot reload hides. Check UI changes with `bun run build && bun run start` before calling them done.

## Project structure

```
gitea-mirror/
├── src/
│   ├── components/      React components, shadcn UI in ui/
│   ├── pages/           Astro pages, API routes under api/
│   ├── lib/             mirroring, sources, push engine, scheduler, auth, db
│   ├── hooks/           React hooks
│   ├── layouts/         page layouts
│   ├── styles/          Tailwind entry points
│   ├── tests/           test setup and helpers (isolated.ts, mock-fetch.ts)
│   └── types/           shared types
├── drizzle/             SQL migrations
├── scripts/             database, recovery and maintenance scripts
├── tests/e2e/           Playwright suite
├── www/                 website and user docs, uses pnpm
├── mcp/                 MCP stdio bridge
├── helm/gitea-mirror/   Helm chart
└── flake.nix            Nix package and NixOS module
```

## Writing an API route

```typescript
// src/pages/api/my-endpoint.ts
import type { APIRoute } from "astro";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";

export const GET: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAuthenticatedUserId({ request, locals });
  if ("response" in authResult) return authResult.response;

  // authResult.userId is the signed-in user, by session or API key
  return new Response(JSON.stringify({ data: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });
};
```

Validate the body with Zod and return JSON errors with a status code. Writes from scripts need `Content-Type: application/json`, and calls to `/api/auth/*` with a cookie need an `Origin` header, or they are refused.

## Database changes

1. Change the table in `src/lib/db/schema.ts`.
2. `bun run db:generate` writes a migration into `drizzle/`. Read the SQL it produced.
3. The app applies pending migrations on startup. `bun run db:migrate` applies them by hand.
4. `bun run db:check` and `bun run test:migrations` must pass.

Query through the exports of `@/lib/db`:

```typescript
import { db, repositories } from "@/lib/db";
import { eq } from "drizzle-orm";

const rows = await db.select().from(repositories).where(eq(repositories.userId, userId));
```

## Tests

- Unit tests sit next to their code as `*.test.ts`.
- `src/tests/setup.bun.ts` is preloaded for every file. It mocks `@/lib/db` and the migrator and makes `setTimeout` fire right away.
- `mock.module` leaks into the files that run after it. A file that mocks modules should call `runsIsolated(import.meta.path)` from `src/tests/isolated.ts` and wrap its tests in `describe.skipIf(!isChild)`.
- A test that needs a real database opens an in-memory SQLite and applies `drizzle/*.sql` itself.
- Run the whole suite before pushing. CI runs the files in a different order than your machine.

## Type checking

TypeScript 7 rejects the `baseUrl` in `tsconfig.json`, so `bunx tsc --noEmit` stops with TS5102. Check with a copy that drops it:

```bash
sed '/"baseUrl"/d' tsconfig.json > tsconfig.typecheck.json
bunx tsc --noEmit -p tsconfig.typecheck.json
```

`main` has existing errors, so compare your branch against it rather than expecting zero. CI does not type check.

## Common problems

- **Port in use:** `bun run dev --port 3001`.
- **Database locked or broken:** stop the server, then `bun run dev:clean`. This deletes your local data.

## Releasing

1. Update `CHANGELOG.md`, and bump the version in `package.json` and `helm/gitea-mirror/Chart.yaml` (`version` and `appVersion`) in one commit on `main`.
2. Tag it: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
3. Publish a GitHub release for the tag with the release notes.

The tag triggers the image build. CI builds the image with the tag's version, publishes the Helm chart with the same version to `oci://ghcr.io/raylabshq/charts/gitea-mirror`, and commits the version to `package.json` and `Chart.yaml` on `main` if step 1 missed it. The version in `flake.nix` is not bumped today.

## Resources

- [Astro](https://docs.astro.build), [Bun](https://bun.sh/docs), [Drizzle ORM](https://orm.drizzle.team), [Better Auth](https://www.better-auth.com/docs), [React](https://react.dev)
