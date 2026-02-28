#!/usr/bin/env bun
/**
 * create-test-repos.ts
 *
 * Programmatically creates bare git repositories with real commits, branches,
 * and tags so that Gitea can actually clone them during E2E testing.
 *
 * Repos are created under <outputDir>/<owner>/<name>.git as bare repositories.
 * After creation, `git update-server-info` is run on each so they can be served
 * via the "dumb HTTP" protocol by any static file server (nginx, darkhttpd, etc.).
 *
 * Usage:
 *   bun run tests/e2e/create-test-repos.ts [--output-dir tests/e2e/git-repos]
 *
 * The script creates the following repositories matching the fake GitHub server's
 * default store:
 *
 *   e2e-test-user/my-project.git   – repo with commits, branches, tags, README
 *   e2e-test-user/dotfiles.git     – simple repo with a few config files
 *   e2e-test-user/notes.git        – minimal repo with one commit
 *   other-user/popular-lib.git     – starred repo from another user
 *   test-org/org-tool.git          – organization repository
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = join(import.meta.dir, "git-repos");

const outputDir = (() => {
  const idx = process.argv.indexOf("--output-dir");
  if (idx !== -1 && process.argv[idx + 1]) {
    return resolve(process.argv[idx + 1]);
  }
  return DEFAULT_OUTPUT_DIR;
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Deterministic committer for reproducible repos
        GIT_AUTHOR_NAME: "E2E Test Bot",
        GIT_AUTHOR_EMAIL: "e2e-bot@test.local",
        GIT_AUTHOR_DATE: "2024-01-15T10:00:00+00:00",
        GIT_COMMITTER_NAME: "E2E Test Bot",
        GIT_COMMITTER_EMAIL: "e2e-bot@test.local",
        GIT_COMMITTER_DATE: "2024-01-15T10:00:00+00:00",
      },
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    throw new Error(
      `git ${args} failed in ${cwd}:\n${stderr || stdout || err.message}`,
    );
  }
}

/** Increment the fake date for each commit so they have unique timestamps */
let commitCounter = 0;
function gitCommit(msg: string, cwd: string): void {
  commitCounter++;
  const date = `2024-01-15T${String(10 + Math.floor(commitCounter / 60)).padStart(2, "0")}:${String(commitCounter % 60).padStart(2, "0")}:00+00:00`;
  execSync(`git commit -m "${msg}"`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "E2E Test Bot",
      GIT_AUTHOR_EMAIL: "e2e-bot@test.local",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "E2E Test Bot",
      GIT_COMMITTER_EMAIL: "e2e-bot@test.local",
      GIT_COMMITTER_DATE: date,
    },
  });
}

function writeFile(repoDir: string, relPath: string, content: string): void {
  const fullPath = join(repoDir, relPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, content, "utf-8");
}

interface RepoSpec {
  owner: string;
  name: string;
  description: string;
  /** Function that populates the working repo with commits/branches/tags */
  populate: (workDir: string) => void;
}

/**
 * Creates a bare repo at <outputDir>/<owner>/<name>.git
 * by first building a working repo, then cloning it as bare.
 */
function createBareRepo(spec: RepoSpec): string {
  const barePath = join(outputDir, spec.owner, `${spec.name}.git`);
  const workPath = join(outputDir, ".work", spec.owner, spec.name);

  // Clean previous
  rmSync(barePath, { recursive: true, force: true });
  rmSync(workPath, { recursive: true, force: true });

  // Create working repo
  mkdirSync(workPath, { recursive: true });
  git("init -b main", workPath);
  git("config user.name 'E2E Test Bot'", workPath);
  git("config user.email 'e2e-bot@test.local'", workPath);

  // Populate with content
  spec.populate(workPath);

  // Clone as bare
  mkdirSync(join(outputDir, spec.owner), { recursive: true });
  git(`clone --bare "${workPath}" "${barePath}"`, outputDir);

  // Enable dumb HTTP protocol support
  git("update-server-info", barePath);

  // Also enable the post-update hook so update-server-info runs on push
  const hookPath = join(barePath, "hooks", "post-update");
  mkdirSync(join(barePath, "hooks"), { recursive: true });
  writeFileSync(hookPath, "#!/bin/sh\nexec git update-server-info\n", {
    mode: 0o755,
  });

  return barePath;
}

// ─── Repository Definitions ──────────────────────────────────────────────────

const repos: RepoSpec[] = [
  // ── my-project: feature-rich repo ────────────────────────────────────────
  {
    owner: "e2e-test-user",
    name: "my-project",
    description: "A test project with branches, tags, and multiple commits",
    populate(dir) {
      // Initial commit
      writeFile(
        dir,
        "README.md",
        "# My Project\n\nA sample project for E2E testing.\n",
      );
      writeFile(
        dir,
        "package.json",
        JSON.stringify(
          {
            name: "my-project",
            version: "1.0.0",
            description: "E2E test project",
            main: "index.js",
          },
          null,
          2,
        ) + "\n",
      );
      writeFile(
        dir,
        "index.js",
        '// Main entry point\nconsole.log("Hello from my-project");\n',
      );
      writeFile(dir, ".gitignore", "node_modules/\ndist/\n.env\n");
      git("add -A", dir);
      gitCommit("Initial commit", dir);

      // Second commit
      writeFile(
        dir,
        "src/lib.js",
        "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n",
      );
      writeFile(
        dir,
        "src/utils.js",
        "export function sum(a, b) {\n  return a + b;\n}\n",
      );
      git("add -A", dir);
      gitCommit("Add library modules", dir);

      // Tag v1.0.0
      git("tag -a v1.0.0 -m 'Initial release'", dir);

      // Create develop branch
      git("checkout -b develop", dir);
      writeFile(
        dir,
        "src/feature.js",
        "export function newFeature() {\n  return 'coming soon';\n}\n",
      );
      git("add -A", dir);
      gitCommit("Add new feature placeholder", dir);

      // Create feature branch from develop
      git("checkout -b feature/add-tests", dir);
      writeFile(
        dir,
        "tests/lib.test.js",
        `import { greet } from '../src/lib.js';
import { sum } from '../src/utils.js';

console.assert(greet('World') === 'Hello, World!');
console.assert(sum(2, 3) === 5);
console.log('All tests passed');
`,
      );
      git("add -A", dir);
      gitCommit("Add unit tests", dir);

      // Go back to main and add another commit
      git("checkout main", dir);
      writeFile(
        dir,
        "README.md",
        "# My Project\n\nA sample project for E2E testing.\n\n## Features\n- Greeting module\n- Math utilities\n",
      );
      git("add -A", dir);
      gitCommit("Update README with features list", dir);

      // Tag v1.1.0
      git("tag -a v1.1.0 -m 'Feature update'", dir);

      // Third commit on main for more history
      writeFile(dir, "LICENSE", "MIT License\n\nCopyright (c) 2024 E2E Test\n");
      git("add -A", dir);
      gitCommit("Add MIT license", dir);
    },
  },

  // ── dotfiles: simple config repo ─────────────────────────────────────────
  {
    owner: "e2e-test-user",
    name: "dotfiles",
    description: "Personal configuration files",
    populate(dir) {
      writeFile(
        dir,
        ".bashrc",
        "# Bash configuration\nalias ll='ls -la'\nalias gs='git status'\nexport EDITOR=vim\n",
      );
      writeFile(
        dir,
        ".vimrc",
        '" Vim configuration\nset number\nset tabstop=2\nset shiftwidth=2\nset expandtab\nsyntax on\n',
      );
      writeFile(
        dir,
        ".gitconfig",
        "[user]\n  name = E2E Test User\n  email = e2e@test.local\n[alias]\n  co = checkout\n  br = branch\n  st = status\n",
      );
      git("add -A", dir);
      gitCommit("Add dotfiles", dir);

      writeFile(
        dir,
        ".tmux.conf",
        "# Tmux configuration\nset -g mouse on\nset -g default-terminal 'screen-256color'\n",
      );
      writeFile(
        dir,
        "install.sh",
        '#!/bin/bash\n# Symlink dotfiles to home\nfor f in .bashrc .vimrc .gitconfig .tmux.conf; do\n  ln -sf "$(pwd)/$f" "$HOME/$f"\ndone\necho \'Dotfiles installed!\'\n',
      );
      git("add -A", dir);
      gitCommit("Add tmux config and install script", dir);
    },
  },

  // ── notes: minimal single-commit repo ────────────────────────────────────
  {
    owner: "e2e-test-user",
    name: "notes",
    description: "Personal notes and documentation",
    populate(dir) {
      writeFile(
        dir,
        "README.md",
        "# Notes\n\nA collection of personal notes.\n",
      );
      writeFile(
        dir,
        "ideas.md",
        "# Ideas\n\n- Build a mirror tool\n- Automate backups\n- Learn Rust\n",
      );
      writeFile(
        dir,
        "todo.md",
        "# TODO\n\n- [x] Set up repository\n- [ ] Add more notes\n- [ ] Organize by topic\n",
      );
      git("add -A", dir);
      gitCommit("Initial notes", dir);
    },
  },

  // ── popular-lib: starred repo from another user ──────────────────────────
  {
    owner: "other-user",
    name: "popular-lib",
    description: "A popular library that we starred",
    populate(dir) {
      writeFile(
        dir,
        "README.md",
        "# Popular Lib\n\nA widely-used utility library.\n\n## Installation\n\n```bash\nnpm install popular-lib\n```\n",
      );
      writeFile(
        dir,
        "package.json",
        JSON.stringify(
          {
            name: "popular-lib",
            version: "2.5.0",
            description: "A widely-used utility library",
            main: "dist/index.js",
            license: "Apache-2.0",
          },
          null,
          2,
        ) + "\n",
      );
      writeFile(
        dir,
        "src/index.ts",
        `/**
 * Popular Lib - utility functions
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function slugify(str: string): string {
  return str.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}
`,
      );
      git("add -A", dir);
      gitCommit("Initial release of popular-lib", dir);

      git("tag -a v2.5.0 -m 'Stable release 2.5.0'", dir);

      // Add a second commit
      writeFile(
        dir,
        "CHANGELOG.md",
        "# Changelog\n\n## 2.5.0\n- Added capitalize, slugify, truncate\n\n## 2.4.0\n- Bug fixes\n",
      );
      git("add -A", dir);
      gitCommit("Add changelog", dir);
    },
  },

  // ── org-tool: organization repo ──────────────────────────────────────────
  {
    owner: "test-org",
    name: "org-tool",
    description: "Internal organization tooling",
    populate(dir) {
      writeFile(
        dir,
        "README.md",
        "# Org Tool\n\nInternal tooling for test-org.\n\n## Usage\n\n```bash\norg-tool run <command>\n```\n",
      );
      writeFile(
        dir,
        "main.go",
        `package main

import "fmt"

func main() {
\tfmt.Println("org-tool v0.1.0")
}
`,
      );
      writeFile(
        dir,
        "go.mod",
        "module github.com/test-org/org-tool\n\ngo 1.21\n",
      );
      writeFile(
        dir,
        "Makefile",
        "build:\n\tgo build -o org-tool .\n\ntest:\n\tgo test ./...\n\nclean:\n\trm -f org-tool\n",
      );
      git("add -A", dir);
      gitCommit("Initial org tool", dir);

      // Add a release branch
      git("checkout -b release/v0.1", dir);
      writeFile(dir, "VERSION", "0.1.0\n");
      git("add -A", dir);
      gitCommit("Pin version for release", dir);
      git("tag -a v0.1.0 -m 'Release v0.1.0'", dir);

      // Back to main with more work
      git("checkout main", dir);
      writeFile(
        dir,
        "cmd/serve.go",
        `package cmd

import "fmt"

func Serve() {
\tfmt.Println("Starting server on :8080")
}
`,
      );
      git("add -A", dir);
      gitCommit("Add serve command", dir);
    },
  },
];

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║          Create E2E Test Git Repositories                    ║",
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════╣",
  );
  console.log(`║  Output directory: ${outputDir}`);
  console.log(`║  Repositories: ${repos.length}`);
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.log("");

  // Verify git is available
  try {
    const version = execSync("git --version", { encoding: "utf-8" }).trim();
    console.log(`[setup] Git version: ${version}`);
  } catch {
    console.error("ERROR: git is not installed or not in PATH");
    process.exit(1);
  }

  // Clean output directory (preserve the directory itself)
  if (existsSync(outputDir)) {
    console.log("[setup] Cleaning previous repos...");
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });

  // Create each repository
  const created: string[] = [];
  for (const spec of repos) {
    const label = `${spec.owner}/${spec.name}`;
    console.log(`\n[repo] Creating ${label} ...`);
    try {
      const barePath = createBareRepo(spec);
      console.log(`[repo] ✓ ${label} → ${barePath}`);
      created.push(label);
    } catch (err) {
      console.error(`[repo] ✗ ${label} FAILED:`, err);
      process.exit(1);
    }
  }

  // Cleanup working directories
  const workDir = join(outputDir, ".work");
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }

  // Write a manifest file so other scripts know what repos exist
  const manifest = {
    createdAt: new Date().toISOString(),
    outputDir,
    repos: repos.map((r) => ({
      owner: r.owner,
      name: r.name,
      description: r.description,
      barePath: `${r.owner}/${r.name}.git`,
    })),
  };
  writeFileSync(
    join(outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );

  console.log(
    "\n═══════════════════════════════════════════════════════════════",
  );
  console.log(` ✅ Created ${created.length} bare repositories:`);
  for (const name of created) {
    console.log(`    • ${name}.git`);
  }
  console.log(`\n    Manifest: ${join(outputDir, "manifest.json")}`);
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
}

main();
