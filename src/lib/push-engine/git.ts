/**
 * Running git for the push engine.
 *
 * Credentials never touch a URL or the disk. Each invocation gets an inline
 * credential helper that answers from two environment variables set on the
 * child process only, so the remote URL git stores in the bare clone stays
 * clean and the token cannot leak into `git remote -v`, logs or a core dump
 * of the repository directory.
 */

export interface GitCredentials {
  username: string;
  token: string;
}

export interface RunGitOptions {
  cwd?: string;
  /** Credentials for the http(s) remote this command talks to, if any. */
  credentials?: GitCredentials | null;
  /** Kill the process after this long. Defaults to one hour: first clones can be big. */
  timeoutMs?: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

const CREDENTIAL_USER_ENV = "GITEA_MIRROR_GIT_USERNAME";
const CREDENTIAL_TOKEN_ENV = "GITEA_MIRROR_GIT_TOKEN";

/**
 * The helper git runs to obtain credentials. A helper starting with "!" is
 * executed through the shell; it prints the answer on stdout.
 */
const INLINE_CREDENTIAL_HELPER =
  `!f() { printf 'username=%s\\npassword=%s\\n' "$${CREDENTIAL_USER_ENV}" "$${CREDENTIAL_TOKEN_ENV}"; }; f`;

export function maskSecret(text: string, secret?: string | null): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

/** Arguments that go before the git subcommand. */
export function credentialArgs(credentials?: GitCredentials | null): string[] {
  const args = [
    // Never fall back to a terminal or GUI prompt: fail instead of hanging.
    "-c",
    "core.askPass=",
  ];
  if (credentials) {
    // An empty value resets the helper list, so a global helper (keychain,
    // store) cannot answer with somebody else's token first.
    args.push("-c", "credential.helper=", "-c", `credential.helper=${INLINE_CREDENTIAL_HELPER}`);
  }
  return args;
}

export async function runGit(args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  const { cwd, credentials = null, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  if (credentials) {
    env[CREDENTIAL_USER_ENV] = credentials.username;
    env[CREDENTIAL_TOKEN_ENV] = credentials.token;
  } else {
    delete env[CREDENTIAL_USER_ENV];
    delete env[CREDENTIAL_TOKEN_ENV];
  }

  const fullArgs = [...credentialArgs(credentials), ...args];
  // The kill timer lives in the runtime, not in a JS timer: the test setup
  // replaces setTimeout with an immediate call, which would kill every git
  // process the moment it starts.
  const proc = Bun.spawn({
    cmd: ["git", ...fullArgs],
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const token = credentials?.token;
  const safeStdout = maskSecret(stdout, token);
  const safeStderr = maskSecret(stderr, token);
  const subcommand = gitSubcommand(args);

  if (proc.signalCode) {
    throw new GitCommandError(
      `git ${subcommand} was stopped (${proc.signalCode}) after ${Math.round(timeoutMs / 1000)}s`,
      args,
      exitCode,
      safeStderr
    );
  }
  if (exitCode !== 0) {
    const detail = [safeStderr, safeStdout].filter(Boolean).join("\n").trim();
    throw new GitCommandError(
      `git ${subcommand} failed (exit ${exitCode}): ${summarize(detail) || "unknown git error"}`,
      args,
      exitCode,
      safeStderr
    );
  }
  return { stdout: safeStdout, stderr: safeStderr };
}

/**
 * The git subcommand in an argv, for error messages. Skips flags and the
 * value that follows `-C` or `-c`, so `["-C", dir, "fetch"]` yields "fetch".
 */
export function gitSubcommand(args: string[]): string {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "-C" || arg === "-c") {
      skipNext = true;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

/** Keep the interesting last lines of git's output for an error message. */
function summarize(detail: string): string {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("remote: Resolving deltas"));
  return lines.slice(-4).join(" | ").slice(0, 600);
}

/** Parse `git for-each-ref` output into a ref -> sha map. */
export function parseRefList(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/, 2);
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}
