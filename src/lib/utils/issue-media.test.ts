import { describe, expect, test } from "bun:test";
import { applyIssueMediaOption, stripIssueMedia } from "./issue-media";

describe("stripIssueMedia", () => {
  test("removes Markdown images but keeps the surrounding text", () => {
    const body = "Before\n\n![screenshot](https://user-images.githubusercontent.com/1/a.png)\n\nAfter";

    expect(stripIssueMedia(body)).toBe("Before\n\n[media omitted]\n\nAfter");
  });

  test("removes images nested inside links", () => {
    const body = "[![preview](https://user-images.githubusercontent.com/1/a.png)](https://example.com)";

    expect(stripIssueMedia(body)).toBe("[media omitted]");
  });

  test("removes HTML media tags", () => {
    const body = 'Text\n<img src="https://example.com/a.png" />\n<video controls><source src="a.mp4"></video>\nEnd';

    const result = stripIssueMedia(body);
    expect(result).toContain("Text");
    expect(result).toContain("End");
    expect(result).not.toContain("<img");
    expect(result).not.toContain("<video");
  });

  test("removes GitHub attachment links", () => {
    const body = "See https://github.com/user-attachments/assets/abc123 and https://user-images.githubusercontent.com/2/b.png";

    expect(stripIssueMedia(body)).toBe("See [media omitted] and [media omitted]");
  });

  test("keeps normal links and code blocks", () => {
    const body = "See [the docs](https://example.com/docs).\n\n```\n![not-an-image](https://example.com/x.png)\n```";

    expect(stripIssueMedia(body)).toBe(body);
  });

  test("returns an empty string for missing bodies", () => {
    expect(stripIssueMedia(null)).toBe("");
    expect(stripIssueMedia(undefined)).toBe("");
  });
});

describe("applyIssueMediaOption", () => {
  test("leaves the body untouched when media is enabled", () => {
    const body = "![screenshot](https://user-images.githubusercontent.com/1/a.png)";
    expect(applyIssueMediaOption(body, true)).toBe(body);
  });

  test("strips media when the option is disabled", () => {
    const body = "![screenshot](https://user-images.githubusercontent.com/1/a.png)";
    expect(applyIssueMediaOption(body, false)).toBe("[media omitted]");
  });
});
