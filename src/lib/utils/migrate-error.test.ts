import { describe, expect, test } from "bun:test";
import {
  migrateRejectionReason,
  withMigrateRejectionReason,
} from "./migrate-error";

function httpError(status: number, response?: string) {
  const error = new Error(`HTTP ${status}: Whatever`) as Error & {
    status: number;
    response?: string;
  };
  error.status = status;
  error.response = response;
  return error;
}

describe("migrateRejectionReason", () => {
  test("reads the message of a rejected migrate request", () => {
    const error = httpError(
      422,
      JSON.stringify({
        message: "You can not import from disallowed hosts.",
        url: "http://gitea.local/api/swagger",
      })
    );
    expect(migrateRejectionReason(error)).toBe(
      "You can not import from disallowed hosts."
    );
  });

  test("ignores anything that is not a 4xx", () => {
    const body = JSON.stringify({ message: "internal detail" });
    expect(migrateRejectionReason(httpError(500, body))).toBeNull();
    expect(migrateRejectionReason(httpError(302, body))).toBeNull();
  });

  test("ignores bodies that are not JSON with a message string", () => {
    expect(migrateRejectionReason(httpError(422, "<html>secret page</html>"))).toBeNull();
    expect(migrateRejectionReason(httpError(422, JSON.stringify({ message: { a: 1 } })))).toBeNull();
    expect(migrateRejectionReason(httpError(422, JSON.stringify(null)))).toBeNull();
    expect(migrateRejectionReason(httpError(422, ""))).toBeNull();
    expect(migrateRejectionReason(httpError(422))).toBeNull();
  });

  test("ignores errors without a status", () => {
    expect(migrateRejectionReason(new Error("boom"))).toBeNull();
    expect(migrateRejectionReason("boom")).toBeNull();
  });

  test("keeps it to one capped line", () => {
    const error = httpError(
      422,
      JSON.stringify({ message: `first\nsecond\t${"x".repeat(500)}` })
    );
    const reason = migrateRejectionReason(error)!;
    expect(reason.startsWith("first second x")).toBe(true);
    expect(reason).not.toContain("\n");
    expect(reason.length).toBe(203);
    expect(reason.endsWith("...")).toBe(true);
  });

  test("drops credentials inside a URL", () => {
    const error = httpError(
      422,
      JSON.stringify({
        message: "Migration failed: clone https://bob:hunter2@example.com/a/b.git.",
      })
    );
    const reason = migrateRejectionReason(error)!;
    expect(reason).toBe("Migration failed: clone https://example.com/a/b.git.");
  });
});

describe("withMigrateRejectionReason", () => {
  test("adds the reason and returns the same error", () => {
    const error = httpError(
      422,
      JSON.stringify({ message: "You can not import from disallowed hosts." })
    );
    error.message = "HTTP 422: Unprocessable Entity";
    const result = withMigrateRejectionReason(error);
    expect(result).toBe(error);
    expect(result.status).toBe(422);
    expect(result.message).toBe(
      "HTTP 422: Unprocessable Entity (destination replied: You can not import from disallowed hosts.)"
    );
    // A second pass does not add it twice.
    expect(withMigrateRejectionReason(error).message).toBe(result.message);
  });

  test("leaves other errors untouched", () => {
    const plain = new Error("network down");
    expect(withMigrateRejectionReason(plain).message).toBe("network down");
    const server = httpError(500, JSON.stringify({ message: "stack trace" }));
    expect(withMigrateRejectionReason(server).message).toBe("HTTP 500: Whatever");
  });
});
