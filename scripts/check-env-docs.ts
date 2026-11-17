#!/usr/bin/env bun
/**
 * Checks that the environment variable reference on the website matches the
 * code. Fails when:
 * - the app reads a variable the reference does not list, or
 * - the reference lists a variable nothing reads.
 *
 * "Reads" means `process.env.NAME`, `import.meta.env.NAME`, `Bun.env.NAME`,
 * `env.NAME` on a ProcessEnv parameter, or the bracket forms, in src/ and
 * scripts/ outside tests, plus the variables docker-entrypoint.sh takes from
 * the environment. The reference is every variable in the first column of a
 * table in www/src/pages/docs/environment-variables.mdx.
 *
 * Run with `bun scripts/check-env-docs.ts`; exits 1 on a mismatch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const referencePage = "www/src/pages/docs/environment-variables.mdx";

/**
 * Read by the code but deliberately left out of the reference. Each entry says
 * why. The check also fails when an entry here is no longer read, so the list
 * cannot go stale.
 */
const NOT_DOCUMENTED: Record<string, string> = {
  ASTRO_NODE_AUTOSTART: "internal: scripts/runtime-server.ts sets it for the Astro node adapter",
  DEPLOYMENT_MODE: "internal",
  JWT_SECRET: "pre-v3 name of BETTER_AUTH_SECRET, still read as a fallback",
  DATABASE_PATH: "only read in src/lib/db/adapter.ts, which nothing imports",
  GITEA_REPAIR_PROGRESS_INTERVAL: "tuning for scripts/repair-mirrored-repos.ts",
  GITEA_REPAIR_REQUEST_TIMEOUT_MS: "tuning for scripts/repair-mirrored-repos.ts",
  // Stored by the env loader, but no code acts on the value.
  GITHUB_TYPE: "stored, never used",
  GITEA_CREATE_ORG: "stored, never used",
  GITEA_FORK_STRATEGY: "stored, never used",
  GITEA_TEMPLATE_OWNER: "stored, never used",
  GITEA_TEMPLATE_REPO: "stored, never used",
  SCHEDULE_AUTO_RETRY: "stored, never used",
  SCHEDULE_CLEANUP_BEFORE_MIRROR: "stored, never used",
  SCHEDULE_LOG_LEVEL: "stored, never used",
  SCHEDULE_NOTIFY_ON_FAILURE: "stored, never used",
  SCHEDULE_NOTIFY_ON_SUCCESS: "stored, never used",
  SCHEDULE_RETRY_ATTEMPTS: "stored, never used",
  SCHEDULE_RETRY_DELAY: "stored, never used",
  SCHEDULE_TIMEOUT: "stored, never used",
  // Only read by getMirrorStrategyConfig in src/lib/utils/mirror-strategies.ts,
  // which nothing calls.
  NON_MIRROR_STRATEGY: "dead code",
  ORG_CREATION_RETRIES: "dead code",
  ORG_CREATION_RETRY_DELAY: "dead code",
  REPO_BATCH_SIZE: "dead code",
  SEQUENTIAL_ORG_CREATION: "dead code",
  SYNC_TIMEOUT: "dead code",
};

/**
 * Listed in the reference but read by something other than the app code:
 * Docker Compose, the Nix wrapper, or the runtime itself.
 */
const READ_ELSEWHERE: Record<string, string> = {
  DOCKER_REGISTRY: "Docker Compose substitution",
  DOCKER_IMAGE: "Docker Compose substitution",
  DOCKER_TAG: "Docker Compose substitution",
  PUID: "Docker Compose substitution",
  PGID: "Docker Compose substitution",
  NODE_EXTRA_CA_CERTS: "read by the Bun runtime; the entrypoint also sets it",
  SERVER_CERT_PATH: "read by the Astro node adapter when dist/server/entry.mjs runs directly",
  SERVER_KEY_PATH: "read by the Astro node adapter when dist/server/entry.mjs runs directly",
};

function trackedFiles(...patterns: string[]): string[] {
  return Bun.spawnSync(["git", "ls-files", ...patterns], { cwd: root })
    .stdout.toString()
    .split("\n")
    .filter(Boolean);
}

const read = new Map<string, string>();
const note = (name: string, file: string) => {
  if (!read.has(name)) read.set(name, file);
};

const codeFiles = trackedFiles("src", "scripts", "astro.config.mjs").filter(
  (file) =>
    /\.(ts|tsx|js|mjs|astro)$/.test(file) &&
    !/\.test\.(ts|tsx)$/.test(file) &&
    !file.startsWith("src/tests/") &&
    !file.startsWith("scripts/check-")
);
const envRead =
  /(?:process\.env|import\.meta\.env|Bun\.env|(?<![.\w])env)(?:\.([A-Z][A-Z0-9_]+)|\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\])/g;
for (const file of codeFiles) {
  const text = readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(envRead)) note(match[1] ?? match[2], file);
}

// The entrypoint: a variable it reads before it ever assigns it comes from
// the environment, and ones it assigns first are its own locals. Function
// bodies run later, so a read there only counts when the script never
// assigns the variable at all.
const entrypoint = readFileSync(path.join(root, "docker-entrypoint.sh"), "utf8");
const assignment = /(?:^|[\s;&|(])(?:export\s+)?([A-Z][A-Z0-9_]+)=/;
const reads = (line: string) => [...line.matchAll(/\$\{?([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
const seen = new Set<string>();
const assignedAnywhere = new Set<string>();
const readInFunctions = new Set<string>();
let inFunction = false;
for (const line of entrypoint.split("\n")) {
  if (/^\s*#/.test(line)) continue;
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/.test(line)) inFunction = true;
  const assigned = assignment.exec(line)?.[1];
  if (assigned) assignedAnywhere.add(assigned);
  if (inFunction) {
    for (const name of reads(line)) readInFunctions.add(name);
    if (/^\}/.test(line)) inFunction = false;
    continue;
  }
  for (const name of reads(line)) {
    if (!seen.has(name)) {
      seen.add(name);
      note(name, "docker-entrypoint.sh");
    }
  }
  if (assigned) seen.add(assigned);
}
for (const name of readInFunctions) {
  if (!assignedAnywhere.has(name)) note(name, "docker-entrypoint.sh");
}

const documented = new Set<string>();
for (const line of readFileSync(path.join(root, referencePage), "utf8").split("\n")) {
  const name = /^\|\s*`([A-Z][A-Z0-9_]+)`/.exec(line)?.[1];
  if (name) documented.add(name);
}

const problems: string[] = [];
for (const [name, file] of [...read].sort()) {
  if (!documented.has(name) && !(name in NOT_DOCUMENTED)) {
    problems.push(`${name} is read in ${file} but missing from ${referencePage}`);
  }
}
for (const name of [...documented].sort()) {
  if (!read.has(name) && !(name in READ_ELSEWHERE)) {
    problems.push(`${name} is listed in ${referencePage} but nothing reads it`);
  }
}
for (const name of Object.keys(NOT_DOCUMENTED)) {
  if (!read.has(name)) problems.push(`${name} is in NOT_DOCUMENTED but nothing reads it any more`);
  if (documented.has(name)) problems.push(`${name} is in NOT_DOCUMENTED but the reference lists it`);
}
for (const name of Object.keys(READ_ELSEWHERE)) {
  if (!documented.has(name)) problems.push(`${name} is in READ_ELSEWHERE but the reference does not list it`);
}

if (problems.length) {
  console.error(`${problems.length} environment variable mismatch(es):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Environment variable reference OK (${documented.size} documented, ${read.size} read)`);
