import type { APIRoute } from "astro";
import { withBase } from "@/lib/base-path";
import { getMcpResourceUrl } from "@/lib/mcp/auth";

export const GET: APIRoute = () => {
  const resource = getMcpResourceUrl();
  const baseUrl = new URL(resource);
  const authorizationServer = `${baseUrl.origin}${withBase("/api/auth")}`;

  return new Response(JSON.stringify({
    resource,
    authorization_servers: [authorizationServer],
    scopes_supported: ["mirror:read", "mirror:sync"],
    bearer_methods_supported: ["header"],
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
