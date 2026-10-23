import { describe, expect, test } from "bun:test";
import { apiNotFoundResponse, isApiNotFoundPage } from "./api-not-found";

function page(status: number, contentType: string) {
  return new Response("<html></html>", { status, headers: { "Content-Type": contentType } });
}

describe("isApiNotFoundPage", () => {
  test("matches Astro's HTML 404 for an /api path", () => {
    expect(isApiNotFoundPage("/api/organizations", page(404, "text/html"))).toBe(true);
    expect(isApiNotFoundPage("/api", page(404, "text/html; charset=utf-8"))).toBe(true);
  });

  test("leaves JSON 404s from route handlers alone", () => {
    expect(isApiNotFoundPage("/api/organizations/x", page(404, "application/json"))).toBe(false);
  });

  test("leaves pages and other statuses alone", () => {
    expect(isApiNotFoundPage("/no-such-page", page(404, "text/html"))).toBe(false);
    expect(isApiNotFoundPage("/apis", page(404, "text/html"))).toBe(false);
    expect(isApiNotFoundPage("/api/health", page(200, "text/html"))).toBe(false);
  });
});

describe("apiNotFoundResponse", () => {
  test("names the method and path in a JSON 404", async () => {
    const response = apiNotFoundResponse("GET", "/api/sync/organization");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      success: false,
      error: "No API endpoint for GET /api/sync/organization. Check the path and the HTTP method.",
    });
  });
});
