import type { APIContext } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { auth } from "@/lib/auth";

// GET /api/auth/sso/sp-metadata - Get Service Provider metadata for SAML
export async function GET(context: APIContext) {
  try {
    const url = new URL(context.request.url);
    const providerId = url.searchParams.get("providerId");
    const format = url.searchParams.get("format") === "json" ? "json" : "xml";

    if (!providerId) {
      return new Response(
        JSON.stringify({ error: "Provider ID is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Get SP metadata using Better Auth's API
    const response = await auth.api.spMetadata({
      query: {
        providerId,
        format,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      return new Response(
        JSON.stringify({ error: `Failed to get SP metadata: ${error}` }),
        {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Return the metadata in the requested format
    if (format === "xml") {
      const metadataXML = await response.text();
      return new Response(metadataXML, {
        status: 200,
        headers: { 
          "Content-Type": "application/samlmetadata+xml",
          "Cache-Control": "public, max-age=86400", // Cache for 24 hours
        },
      });
    } else {
      const metadataJSON = await response.json();
      return new Response(JSON.stringify(metadataJSON), {
        status: 200,
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
  } catch (error) {
    return createSecureErrorResponse(error, "SP metadata");
  }
}
