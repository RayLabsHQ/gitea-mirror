import { describe, test, expect } from "bun:test";
import { jsonResponse, formatDate, formatDateShort, truncate, safeParse, parseErrorMessage, showErrorToast } from "./utils";

describe("jsonResponse", () => {
  test("creates a Response with JSON content", () => {
    const data = { message: "Hello, world!" };
    const response = jsonResponse({ data });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("uses the provided status code", () => {
    const data = { error: "Not found" };
    const response = jsonResponse({ data, status: 404 });

    expect(response.status).toBe(404);
  });

  test("correctly serializes complex objects", async () => {
    const now = new Date();
    const data = {
      message: "Complex object",
      date: now,
      nested: { foo: "bar" },
      array: [1, 2, 3]
    };

    const response = jsonResponse({ data });
    const responseBody = await response.json();

    expect(responseBody).toEqual({
      message: "Complex object",
      date: now.toISOString(),
      nested: { foo: "bar" },
      array: [1, 2, 3]
    });
  });
});

describe("formatDate", () => {
  test("formats a date object", () => {
    const date = new Date("2023-01-15T12:30:45Z");
    const formatted = formatDate(date);

    // The exact format might depend on the locale, so we'll check for parts
    expect(formatted).toContain("2023");
    expect(formatted).toContain("January");
    expect(formatted).toContain("15");
  });

  test("formats a date string", () => {
    const dateStr = "2023-01-15T12:30:45Z";
    const formatted = formatDate(dateStr);

    expect(formatted).toContain("2023");
    expect(formatted).toContain("January");
    expect(formatted).toContain("15");
  });

  test("returns 'Never' for null or undefined", () => {
    expect(formatDate(null)).toBe("Never");
    expect(formatDate(undefined)).toBe("Never");
  });
});

describe("formatDateShort", () => {
  test("returns formatted date when input is provided", () => {
    const formatted = formatDateShort("2014-10-20T15:32:10Z");
    expect(formatted).toBe("Oct 20, 2014");
  });

  test("returns undefined when date is missing", () => {
    expect(formatDateShort(null)).toBeUndefined();
    expect(formatDateShort(undefined)).toBeUndefined();
  });
});

describe("truncate", () => {
  test("truncates a string that exceeds the length", () => {
    const str = "This is a long string that needs truncation";
    const truncated = truncate(str, 10);

    expect(truncated).toBe("This is a ...");
    expect(truncated.length).toBe(13); // 10 chars + "..."
  });

  test("does not truncate a string that is shorter than the length", () => {
    const str = "Short";
    const truncated = truncate(str, 10);

    expect(truncated).toBe("Short");
  });

  test("handles empty strings", () => {
    expect(truncate("", 10)).toBe("");
  });
});

describe("safeParse", () => {
  test("parses valid JSON strings", () => {
    const jsonStr = '{"name":"John","age":30}';
    const parsed = safeParse(jsonStr);

    expect(parsed).toEqual({ name: "John", age: 30 });
  });

  test("returns undefined for invalid JSON strings", () => {
    const invalidJson = '{"name":"John",age:30}'; // Missing quotes around age
    const parsed = safeParse(invalidJson);

    expect(parsed).toBeUndefined();
  });

  test("returns the original value for non-string inputs", () => {
    const obj = { name: "John", age: 30 };
    const parsed = safeParse(obj);

    expect(parsed).toBe(obj);
  });
});

describe("parseErrorMessage", () => {
  test("parses JSON error with error and troubleshooting fields", () => {
    const errorMessage = JSON.stringify({
      error: "Unexpected end of JSON input",
      errorType: "SyntaxError",
      timestamp: "2025-05-28T09:08:02.37Z",
      troubleshooting: "JSON parsing error detected. Check Gitea server status and logs. Ensure Gitea is returning valid JSON responses."
    });

    const result = parseErrorMessage(errorMessage);

    expect(result.title).toBe("Unexpected end of JSON input");
    expect(result.description).toBe("JSON parsing error detected. Check Gitea server status and logs. Ensure Gitea is returning valid JSON responses.");
    expect(result.isStructured).toBe(true);
  });

  test("parses JSON error with title and description fields", () => {
    const errorMessage = JSON.stringify({
      title: "Connection Failed",
      description: "Unable to connect to the server. Please check your network connection."
    });

    const result = parseErrorMessage(errorMessage);

    expect(result.title).toBe("Connection Failed");
    expect(result.description).toBe("Unable to connect to the server. Please check your network connection.");
    expect(result.isStructured).toBe(true);
  });

  test("handles plain string error messages", () => {
    const errorMessage = "Simple error message";

    const result = parseErrorMessage(errorMessage);

    expect(result.title).toBe("Simple error message");
    expect(result.description).toBeUndefined();
    expect(result.isStructured).toBe(false);
  });

  test("handles Error objects", () => {
    const error = new Error("Something went wrong");

    const result = parseErrorMessage(error);

    expect(result.title).toBe("Something went wrong");
    expect(result.description).toBeUndefined();
    expect(result.isStructured).toBe(false);
  });

  test("adds trusted origins guidance for invalid origin errors", () => {
    const errorMessage = "Invalid Origin: https://mirror.example.com";

    const result = parseErrorMessage(errorMessage);

    expect(result.title).toBe("Invalid Origin");
    expect(result.description).toContain("BETTER_AUTH_TRUSTED_ORIGINS");
    expect(result.description).toContain("https://mirror.example.com");
    expect(result.isStructured).toBe(true);
  });
});

describe("showErrorToast", () => {
  test("shows invalid origin guidance in toast description", () => {
    const calls: any[] = [];
    const toast = {
      error: (...args: any[]) => calls.push(args),
    };

    showErrorToast("Invalid Origin: http://10.10.20.45:4321", toast);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("Invalid Origin");
    expect(calls[0][1].description).toContain("BETTER_AUTH_TRUSTED_ORIGINS");
    expect(calls[0][1].description).toContain("http://10.10.20.45:4321");
  });
});
