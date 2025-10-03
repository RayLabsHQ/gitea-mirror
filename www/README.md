# Gitea Mirror Marketing Site

This Astro workspace powers the public marketing experience for Gitea Mirror. It includes the landing page, screenshots, call-to-action components, and the new use case library that highlights real-world workflows.

## Developing Locally

```bash
bun install
bun run dev
```

The site is available at `http://localhost:4321`. Tailwind CSS v4 handles styling; classes can be used directly inside Astro, MDX, and React components.

## Project Structure

- `src/pages/index.astro` – Main landing page
- `src/components/` – Reusable UI (Header, Hero, Features, UseCases, etc.)
- `src/lib/use-cases.ts` – Central data source for use case titles, summaries, and tags
- `src/pages/use-cases/` – MDX guides for each use case, rendered with `UseCaseLayout`
- `src/layouts/UseCaseLayout.astro` – Shared layout that injects the header, shader background, and footer into MDX guides

## Authoring Use Case Guides

1. Add or update a record in `src/lib/use-cases.ts`. This keeps the landing page and library listing in sync.
2. Create a new MDX file in `src/pages/use-cases/<slug>.mdx` with the `UseCaseLayout` layout and descriptive frontmatter.
3. Run `bun run dev` to preview the layout and ensure the new guide inherits global styles.

## Deployment

The marketing site is built with the standard Astro pipeline. Use `bun run build` to generate a production build before deploying.
