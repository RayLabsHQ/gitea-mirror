# Contributing to Gitea Mirror

Thanks for helping out. This page covers getting set up, what fits the project, and what a pull request needs. [docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md) has the local setup in more detail, and [CLAUDE.md](CLAUDE.md) has a map of the code.

## Getting started

You need [Bun](https://bun.sh) 1.2.9 or later.

```bash
git clone https://github.com/<your-username>/gitea-mirror.git
cd gitea-mirror
bun run setup     # install dependencies and create the database
bun run dev       # http://localhost:4321
```

The first account you sign up with becomes the admin. A `.env` file is optional for development; copy `.env.example` if you want to preset settings.

To start over with an empty database: `bun run dev:clean`.

## What fits

Gitea Mirror is for people and small teams who self-host. Contributions should keep it that way:

- Mirroring and syncing come first.
- Easy to self-host: one instance, SQLite, no extra services to run.
- Few new dependencies.

If you plan something large, open an issue first so we can agree on the approach.

## Code

- TypeScript everywhere. Import with the `@/` alias.
- There is no formatter configured. Match the style of the file you are editing: two spaces, and its existing quotes and semicolons.
- Add tests for new logic. They sit next to the code as `*.test.ts` and run with `bun test`. Read the Testing section of [CLAUDE.md](CLAUDE.md) before mocking modules, because module mocks leak between test files.
- New settings need a Zod schema, a type, a UI control and, if they have an environment variable, a row on the [environment variables page](www/src/pages/docs/environment-variables.mdx). CI fails when the code reads a variable the page does not list.

## Pull requests

1. Branch from `main`.
2. Run what CI runs:
   ```bash
   bun test --coverage
   bun run db:check
   bun run test:migrations
   bun run build
   ```
   CI also runs the Playwright suite (`bun run test:e2e`, needs Docker or Podman), a link check over the docs (`bun scripts/check-docs-links.ts`) and the environment variable check (`bun scripts/check-env-docs.ts`).
3. Write a plain commit message, conventional style: `fix(mirror): ...`, `feat(sources): ...`, `docs: ...`.
4. Open the pull request with what changed, why, and how you tested it. Add screenshots for UI changes, and say so if it needs a database migration or changes an environment variable.

User facing changes need the matching page on the website updated in the same pull request. The pages are in [www/src/pages/docs/](www/src/pages/docs/) and are published at https://gitea-mirror.raylabs.io/docs/.

## Reporting issues

Search the existing issues first. Include your version, how you run it (Docker, Helm, Nix, bare metal), your source and destination, the steps to reproduce, and the relevant log lines. Report security problems privately through [GitHub security advisories](https://github.com/RayLabsHQ/gitea-mirror/security), not in an issue.

## License

By contributing, you agree that your contributions are licensed under the project's license, the [GNU Affero General Public License v3.0](LICENSE).
