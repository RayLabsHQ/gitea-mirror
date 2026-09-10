import { describe, test, expect } from "bun:test";
import { resolveDestinationSaveValue } from "./destination-editor";

describe("resolveDestinationSaveValue (#416)", () => {
  test("an empty input clears the override", () => {
    expect(resolveDestinationSaveValue("")).toBeNull();
  });

  test("whitespace only also clears the override", () => {
    expect(resolveDestinationSaveValue("   ")).toBeNull();
    expect(resolveDestinationSaveValue("\t\n ")).toBeNull();
  });

  test("the organization's own name is kept as an override", () => {
    // Under single-org the default is the configured destination org, so
    // "GrapheneOS" on the organization GrapheneOS is a real override.
    expect(resolveDestinationSaveValue("GrapheneOS")).toBe("GrapheneOS");
  });

  test("the value the strategy would produce is kept as an override", () => {
    // Pinning a repository to "mirrors" while single-org already sends
    // everything there must survive a later strategy change.
    expect(resolveDestinationSaveValue("mirrors")).toBe("mirrors");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(resolveDestinationSaveValue("  GrapheneOS  ")).toBe("GrapheneOS");
    expect(resolveDestinationSaveValue("\tmirrors\n")).toBe("mirrors");
  });
});
