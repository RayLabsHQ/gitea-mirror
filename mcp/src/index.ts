import { createInterface } from "node:readline";
import { createBridge } from "./bridge";
import { ConfigError, readConfig } from "./config";

// stdout carries the protocol, so every message for people goes to stderr.
function main(): void {
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

  const bridge = createBridge({
    ...config,
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    log: (text) => console.error(`gitea-mirror-mcp: ${text}`),
  });
  console.error(`gitea-mirror-mcp: relaying to ${bridge.endpoint}`);

  // Messages are relayed as they arrive; answers carry their request id, so
  // they may go back in any order.
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const relayed = bridge.relay(line).finally(() => pending.delete(relayed));
    pending.add(relayed);
  });
  lines.on("close", async () => {
    await Promise.allSettled([...pending]);
    // Writes to a pipe are asynchronous on macOS; exit once the last
    // answer has been flushed.
    process.stdout.write("", () => process.exit(0));
  });
}

main();
