import { describe, expect, test } from "bun:test";
import { ALL } from "./mcp";

describe("POST /api/mcp", () => {
  test("rejects missing OAuth bearer credentials before creating an MCP session", async () => {
    const response = await ALL({
      request: new Request("http://localhost/api/mcp", { method: "POST" }),
    } as never);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });
});
