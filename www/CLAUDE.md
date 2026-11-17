# CLAUDE.md

Guidance for Claude Code when working in `www/`, the public website for Gitea Mirror at https://gitea-mirror.raylabs.io. The app itself lives in the parent directory.

## Commands

```bash
pnpm install        # pnpm-lock.yaml is the lockfile
pnpm dev            # dev server on http://localhost:4321
pnpm build          # static build into dist/
pnpm preview        # serve the build
```

From the repository root, `bun scripts/check-docs-links.ts` checks every link in the site and the repository markdown. CI runs it on every change to `www/src` or a `.md` file.

The site uses pnpm. Never commit a `bun.lock` here: Cloudflare Pages installs with Bun when it finds one, and that build fails.

## Stack

Astro 7 (static output) with MDX, React 19, Tailwind CSS v4 through the Vite plugin, and `@astrojs/sitemap`.

## What lives where

- `src/pages/index.astro`: the landing page, built from the components in `src/components/` (Hero, Features, Screenshots, UseCases, Installation, FAQ, CTA, Footer).
- `src/pages/docs/*.mdx`: the user documentation. Every page uses `DocsLayout.astro`.
- `src/lib/docs-nav.ts`: the docs sidebar and the previous/next links. A new docs page needs an entry here.
- `src/pages/use-cases/*.mdx`: the use case guides, using `UseCaseLayout.astro`. Each needs a record in `src/lib/use-cases.ts`, which feeds the landing page cards and the use case index.
- `src/pages/comparison/`: comparison pages.
- `src/pages/404.astro`: the not found page.
- `public/assets/`: screenshots for the site. This is a separate copy from `.github/assets/` in the repository root, which the README uses.

## Writing the docs

- The docs describe the app in the parent directory, and the code is the source of truth. Check a default, a setting name or a button label in the code before writing it down.
- `docs/` in the repository root holds maintainer notes only. User facing content belongs here.
- Link with site paths such as `/docs/sources/` or `/docs/deployment/#nix-and-nixos`. Relative `./page.md` links are not rewritten and the link checker rejects them.
- When the app gains or loses an environment variable, update `src/pages/docs/environment-variables.mdx`.
- Name buttons and pages the way the app does: the settings page is **Configuration**, not Settings.
- Keep the writing plain and short.
