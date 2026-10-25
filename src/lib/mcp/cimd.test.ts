import { describe, expect, test } from "bun:test";
import { cimd, createCimdClientDiscovery, validateCimdMetadata, validateClientIdUrl } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";

const clientId = "https://client.example.test/oauth/client-metadata.json";

const validMetadata = {
  client_id: clientId,
  client_name: "MCP test client",
  redirect_uris: ["http://127.0.0.1:54321/oauth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

describe("MCP Client ID Metadata Documents", () => {
  test("validates MCP-profile metadata bound to its HTTPS client ID", () => {
    expect(validateCimdMetadata(clientId, validMetadata, {
      metadataProfile: "mcp-2026-07-28",
    }).valid).toBe(true);
    expect(validateCimdMetadata(clientId, {
      ...validMetadata,
      client_id: "https://other.example.test/client.json",
    }, { metadataProfile: "mcp-2026-07-28" }).valid).toBe(false);
  });

  test("requires MCP client name and redirect URIs", () => {
    expect(validateCimdMetadata(clientId, {
      ...validMetadata,
      client_name: undefined,
    }, { metadataProfile: "mcp-2026-07-28" }).valid).toBe(false);
    expect(validateCimdMetadata(clientId, {
      ...validMetadata,
      redirect_uris: undefined,
    }, { metadataProfile: "mcp-2026-07-28" }).valid).toBe(false);
  });

  test("rejects non-HTTPS and private-address client document URLs", () => {
    expect(validateClientIdUrl("http://client.example.test/client.json")).toContain("HTTPS");
    expect(validateClientIdUrl("https://127.0.0.1/client.json")).toContain("private or reserved");
    expect(validateClientIdUrl(clientId)).toBeNull();
  });

  test("advertises CIMD and routes HTTPS client IDs to discovery", () => {
    const options = {
      fetchClientMetadataResource: async () => new Response("{}"),
      metadataProfile: "mcp-2026-07-28" as const,
    };
    const discovery = createCimdClientDiscovery(options);
    expect(discovery.matches(clientId)).toBe(true);
    expect(discovery.matches("managed-client-id")).toBe(false);
    expect(discovery.discoveryMetadata).toEqual({ client_id_metadata_document_supported: true });
    expect(cimd(options).id).toBe("cimd");
  });

  test("the Node transport refuses private network destinations under Bun", async () => {
    await expect(
      fetchClientMetadataResource("https://127.0.0.1/client-metadata.json"),
    ).rejects.toThrow("public-routable");
  });
});
