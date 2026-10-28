/**
 * Settings come from the environment the MCP client starts the bridge with,
 * so the key never appears in a tool call or a prompt.
 */

export interface McpConfig {
  /** App origin plus any BASE_URL prefix, without a trailing slash. */
  baseUrl: string;
  apiKey: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function readConfig(env: Record<string, string | undefined>): McpConfig {
  const rawUrl = env.GITEA_MIRROR_URL?.trim();
  if (!rawUrl) {
    throw new ConfigError(
      "GITEA_MIRROR_URL is not set. Point it at your Gitea Mirror, for example https://mirror.example.com."
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`GITEA_MIRROR_URL is not a URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("GITEA_MIRROR_URL must start with http:// or https://.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      "GITEA_MIRROR_URL should be the address you open in the browser, without credentials, a query or a #fragment."
    );
  }

  const apiKey = env.GITEA_MIRROR_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "GITEA_MIRROR_API_KEY is not set. Create a key under Configuration, Authentication, API Keys."
    );
  }

  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    apiKey,
  };
}
