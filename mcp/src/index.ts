import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GiteaMirrorClient } from "./client";
import { ConfigError, readConfig } from "./config";
import { createServer } from "./server";

// stdout carries the protocol, so every message for people goes to stderr.
async function main(): Promise<void> {
  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`gitea-mirror-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const client = new GiteaMirrorClient(config);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  console.error(`gitea-mirror-mcp: connected to ${client.baseUrl}`);
}

main().catch((error) => {
  console.error("gitea-mirror-mcp:", error);
  process.exit(1);
});
