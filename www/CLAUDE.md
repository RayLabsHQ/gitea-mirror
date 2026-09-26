# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the marketing website for Gitea Mirror, built with Astro and Tailwind CSS v4. It serves as a landing page to showcase the Gitea Mirror application's features and provide getting started information.

**Note**: This is NOT the main Gitea Mirror application. The actual application is located in the parent directory (`../`).

## Essential Commands

```bash
pnpm install        # Install dependencies (pnpm-lock.yaml is the lockfile)
pnpm dev            # Start development server (port 4321)
pnpm build          # Build for production
pnpm preview        # Preview production build
```

## Architecture & Key Concepts

### Technology Stack
- **Framework**: Astro (v7) - Static site generator with React integration
- **UI**: React (v19.0.0) + Tailwind CSS v4
- **Package manager**: pnpm. Do not commit a bun.lock: Cloudflare Pages installs with Bun when it finds one
- **Styling**: Tailwind CSS v4 with Vite plugin

### Project Structure
- `/src/pages/` - Astro pages (single `index.astro` page)
- `/src/components/` - React components for UI sections
  - `Hero.tsx` - Landing hero section
  - `Features.tsx` - Feature showcase
  - `GettingStarted.tsx` - Installation and setup guide
  - `Screenshots.tsx` - Product screenshots gallery
  - `Footer.tsx` - Page footer
- `/src/layouts/` - Layout wrapper components
- `/public/assets/` - Static assets (shared with main project)
- `/public/favicon.svg` - Site favicon

### Key Implementation Details

1. **Single Page Application**: The entire website is a single page (`index.astro`) composed of React components.

2. **Responsive Design**: All components use Tailwind CSS for responsive layouts with mobile-first approach.

3. **Asset Sharing**: Screenshots and images are shared with the main Gitea Mirror project (located in `/public/assets/`).

4. **Component Pattern**: Each major section is a separate React component with TypeScript interfaces for props.

### Development Guidelines

**When updating content:**
- Hero section copy is in `Hero.tsx`
- Features are defined in `Features.tsx` as an array
- Getting started steps are in `GettingStarted.tsx`
- Screenshots are referenced from `/public/assets/`

**When adding new sections:**
1. Create a new component in `/src/components/`
2. Import and add it to `index.astro`
3. Follow the existing pattern of full-width sections with container constraints

**Styling conventions:**
- Use Tailwind CSS v4 classes exclusively
- Follow the existing color scheme (zinc/neutral grays, blue accents)
- Maintain consistent spacing using Tailwind's spacing scale
- Keep mobile responsiveness in mind

### Common Tasks

**Updating screenshots:**
- Screenshots should match those in the main application
- Place new screenshots in `/public/assets/`
- Update the `Screenshots.tsx` component to reference new images

**Modifying feature list:**
- Edit the `features` array in `Features.tsx`
- Each feature needs: icon, title, and description
- Icons come from `lucide-react`

**Changing getting started steps:**
- Edit the content in `GettingStarted.tsx`
- Docker and direct installation tabs are separate sections
- Code blocks use `<pre>` and `<code>` tags with Tailwind styling

## Relationship to Main Project

This website showcases the Gitea Mirror application located in the parent directory. When making updates:
- Ensure feature descriptions match actual capabilities
- Keep version numbers and requirements synchronized
- Use the same screenshots as the main application's documentation
- Maintain consistent branding and messaging