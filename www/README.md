# Gitea Mirror website

The source of https://gitea-mirror.raylabs.io: the landing page, the user documentation and the use case guides.

## Developing locally

```bash
pnpm install
pnpm dev
```

The site runs at http://localhost:4321. Run `bun scripts/check-docs-links.ts` from the repository root before opening a pull request; CI runs it too.

## Structure

- `src/pages/index.astro`: the landing page, built from the components in `src/components/`
- `src/pages/docs/`: the documentation, one MDX file per page, listed in `src/lib/docs-nav.ts`
- `src/pages/use-cases/`: the use case guides, listed in `src/lib/use-cases.ts`
- `src/pages/comparison/`: comparison pages
- `public/assets/`: screenshots and images

## Adding a docs page

1. Create `src/pages/docs/<slug>.mdx` with `layout: '../../layouts/DocsLayout.astro'`, a `title` and a `description`.
2. Add it to `src/lib/docs-nav.ts` in the right section.
3. Link to it with its site path, such as `/docs/<slug>/`.

## Adding a use case

1. Add a record to `src/lib/use-cases.ts`. The landing page and the use case index read it.
2. Create `src/pages/use-cases/<slug>.mdx` with `layout: ../../layouts/UseCaseLayout.astro`, a `title`, a `description` and a `canonical` URL.

## Deployment

The site is deployed on Cloudflare Pages. Keep `pnpm-lock.yaml` as the only lockfile here: with a `bun.lock` present, Cloudflare installs with Bun and the build fails.
