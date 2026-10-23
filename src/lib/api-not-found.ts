import { stripBasePath } from "./base-path";

/**
 * Astro answers a request under /api that matches no route, or a route that
 * does not export the request's method, with the HTML "Page Not Found" page.
 * Scripts and integrations get a JSON error naming the method and path
 * instead, so a wrong method reads differently from an id that was not found.
 */
export function isApiNotFoundPage(pathname: string, response: Response): boolean {
  if (response.status !== 404) return false;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return false;
  const path = stripBasePath(pathname);
  return path === "/api" || path.startsWith("/api/");
}

export function apiNotFoundResponse(method: string, pathname: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: `No API endpoint for ${method} ${pathname}. Check the path and the HTTP method.`,
    }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}
