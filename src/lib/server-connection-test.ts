import type { Server } from "@/lib/db/schema";

const CONNECTION_TIMEOUT_MS = 10000;

type TestableServer = Pick<Server, "type" | "url">;

async function testHttpConnection(
  server: TestableServer,
  token: string
): Promise<{ success: boolean; message: string }> {
  const baseUrl = server.url.endsWith("/") ? server.url.slice(0, -1) : server.url;

  let url: string;
  let headers: Record<string, string>;
  switch (server.type) {
    case "github":
      url = "https://api.github.com/user";
      headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      break;
    case "gitlab":
      url = `${baseUrl}/api/v4/user`;
      headers = { "PRIVATE-TOKEN": token, Accept: "application/json" };
      break;
    case "gitea":
    case "forgejo":
      url = `${baseUrl}/api/v1/user`;
      headers = { Authorization: `token ${token}`, Accept: "application/json" };
      break;
    default:
      return { success: false, message: `Unsupported server type: ${server.type}` };
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });

    if (response.ok) {
      return { success: true, message: "Connection successful" };
    }
    if (response.status === 401 || response.status === 403) {
      return { success: false, message: "Authentication failed" };
    }
    return {
      success: false,
      message: `Connection failed: server responded with status ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Connection failed: ${message}` };
  }
}

async function testGitConnection(
  server: TestableServer
): Promise<{ success: boolean; message: string }> {
  try {
    const proc = Bun.spawn(["git", "ls-remote", server.url], {
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Process may have already exited.
      }
    }, CONNECTION_TIMEOUT_MS);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode === 0) {
      return { success: true, message: "Connection successful" };
    }

    const stderr = await new Response(proc.stderr).text();
    return {
      success: false,
      message: `git ls-remote failed (exit code ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Connection failed: ${message}` };
  }
}

export function testServerConnection(
  server: TestableServer,
  token: string
): Promise<{ success: boolean; message: string }> {
  return server.type === "git"
    ? testGitConnection(server)
    : testHttpConnection(server, token);
}
