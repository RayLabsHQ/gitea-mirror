#!/usr/bin/env bun
/**
 * Checks the links in the docs website and the README.
 *
 * The site does not rewrite relative `./page.md` links, and Cloudflare Pages
 * answered every unknown path with the homepage, so 38 links in the docs sent
 * readers to the homepage for months without anyone noticing. This fails on:
 * - a relative link to a .md file in a site page
 * - a site link (/docs/..., /use-cases/..., /comparison/...) to a page that
 *   does not exist, or to a heading anchor the page does not have
 * - a relative link in a repository markdown file (README.md, docs/ and the
 *   rest) to a file that does not exist
 *
 * Run with `bun scripts/check-docs-links.ts`; exits 1 when something is broken.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const pagesDir = path.join(root, "www/src/pages");
const SITE = "https://gitea-mirror.raylabs.io";
const SITE_SECTIONS = /^\/(docs|use-cases|comparison)(\/|$)/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The page file a site path is served from, if any. */
function pageFor(sitePath: string): string | undefined {
  const clean = sitePath.replace(/\/$/, "");
  for (const candidate of [
    `${clean}.mdx`,
    `${clean}.md`,
    `${clean}.astro`,
    `${clean}/index.mdx`,
    `${clean}/index.md`,
    `${clean}/index.astro`,
  ]) {
    const file = path.join(pagesDir, candidate);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** Heading anchors the way Astro's markdown builds them (github-slugger). */
function anchorsOf(file: string): Set<string> | undefined {
  if (!/\.mdx?$/.test(file)) return undefined; // .astro pages: not checked
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const heading = !inFence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const text = heading[1]
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_]/g, "");
    let slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    anchors.add(slug);
  }
  return anchors;
}

const problems: string[] = [];

function checkSiteLink(source: string, target: string) {
  const [sitePath, anchor] = target.split("#");
  const page = pageFor(sitePath);
  if (!page) {
    problems.push(`${source}: ${target} has no page`);
    return;
  }
  if (anchor) {
    const anchors = anchorsOf(page);
    if (anchors && !anchors.has(anchor)) problems.push(`${source}: ${target} has no #${anchor} heading`);
  }
}

const linkPattern = /\]\(([^)\s]+)\)|href=["'{`]+([^"'}`\s]+)["'}`]/g;

for (const file of walk(path.join(root, "www/src")).filter((f) => /\.(mdx?|astro|tsx?)$/.test(f))) {
  const source = path.relative(root, file);
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1] ?? match[2];
    if (target.includes("${")) continue; // built at runtime, checked below for use cases
    if (/^\.{1,2}\/.*\.md(#|$)/.test(target)) {
      problems.push(`${source}: ${target} is a relative .md link; use the site path, such as /docs/sources/`);
    } else if (SITE_SECTIONS.test(target)) {
      checkSiteLink(source, target);
    }
  }
  // Nav entries in docs-nav.ts and similar data files.
  for (const match of text.matchAll(/href:\s*['"]([^'"]+)['"]/g)) {
    if (SITE_SECTIONS.test(match[1])) checkSiteLink(source, match[1]);
  }
}

// Use case cards build their links from the slugs in use-cases.ts.
const useCases = readFileSync(path.join(root, "www/src/lib/use-cases.ts"), "utf8");
for (const match of useCases.matchAll(/slug:\s*['"]([^'"]+)['"]/g)) {
  checkSiteLink("www/src/lib/use-cases.ts", `/use-cases/${match[1]}/`);
}

// Every other markdown file in the repository: site links must exist, and
// relative links must point at a file that does, from the file's own folder.
const markdownFiles = Bun.spawnSync(["git", "ls-files", "*.md"], { cwd: root })
  .stdout.toString()
  .split("\n")
  .filter((file) => file && !file.startsWith("www/src/"));
for (const source of markdownFiles) {
  const text = readFileSync(path.join(root, source), "utf8");
  for (const match of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    const url = URL.canParse(target) ? new URL(target) : null;
    if (url?.origin === SITE) {
      const sitePath = url.pathname + url.hash;
      if (SITE_SECTIONS.test(sitePath)) checkSiteLink(source, sitePath);
    } else if (!/^[a-z][a-z0-9+.-]*:|^#|^\//i.test(target)) {
      const file = path.join(root, path.dirname(source), decodeURI(target.split("#")[0]));
      if (!existsSync(file)) problems.push(`${source}: ${target} does not exist`);
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} broken link(s):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("Docs links OK");
