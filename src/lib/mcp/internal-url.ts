import { getBasePath } from "@/lib/base-path";

/**
 * Where the app answers its own REST API. The MCP tools call it the way a
 * script would, so they need the address the server listens on, not the
 * public one: behind a reverse proxy or a tunnel that one may not be
 * reachable from the server itself.
 *
 * The node adapter listens on HOST and PORT (the Docker image sets
 * 0.0.0.0:4321). A wildcard host is reached through loopback.
 * MCP_INTERNAL_URL overrides all of it for setups that differ.
 */
export function internalApiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const override = env.MCP_INTERNAL_URL?.trim();
  if (override) return override.replace(/\/+$/, "");

  const port = env.PORT?.trim() || "4321";
  const host = env.HOST?.trim() || "localhost";
  let hostname: string;
  if (host === "0.0.0.0") hostname = "127.0.0.1";
  else if (host === "::" || host === "[::]") hostname = "[::1]";
  else if (host.includes(":") && !host.startsWith("[")) hostname = `[${host}]`;
  else hostname = host;

  const basePath = getBasePath();
  return `http://${hostname}:${port}${basePath === "/" ? "" : basePath}`;
}
