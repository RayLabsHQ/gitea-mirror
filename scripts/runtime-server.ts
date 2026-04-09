import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || !basePath.trim()) {
    return "/";
  }

  let normalized = basePath.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/+$/, "");
  return normalized || "/";
}

function rewriteRequestUrl(rawUrl: string, basePath: string): string | null {
  if (basePath === "/") {
    return rawUrl;
  }

  const url = new URL(rawUrl, "http://localhost");
  const pathname = url.pathname;

  if (pathname === basePath || pathname === `${basePath}/`) {
    url.pathname = "/";
    return `${url.pathname}${url.search}`;
  }

  if (pathname.startsWith(`${basePath}/`)) {
    url.pathname = pathname.slice(basePath.length) || "/";
    return `${url.pathname}${url.search}`;
  }

  return null;
}

const basePath = normalizeBasePath(process.env.BASE_URL);
const host = process.env.HOST || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "4321", 10);

process.env.ASTRO_NODE_AUTOSTART = "disabled";
const { handler } = await import("../dist/server/entry.mjs");

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  const rewrittenUrl = rewriteRequestUrl(req.url, basePath);
  if (rewrittenUrl === null) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  req.url = rewrittenUrl;
  req.headers["x-gitea-mirror-base-rewritten"] = "1";

  Promise.resolve((handler as unknown as (request: IncomingMessage, response: ServerResponse) => unknown)(req, res)).catch((error) => {
    console.error("Unhandled runtime server error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    } else {
      res.end();
    }
  });
});

server.listen(port, host, () => {
  console.log(`Runtime server listening on http://${host}:${port} (BASE_URL=${basePath})`);
});
