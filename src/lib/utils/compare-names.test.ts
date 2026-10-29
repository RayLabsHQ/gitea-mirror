import { describe, expect, test } from "bun:test";
import { compareNames } from "./compare-names";

describe("compareNames", () => {
  test("ignores case", () => {
    expect(["Zebra", "apple", "Mango"].sort(compareNames)).toEqual([
      "apple",
      "Mango",
      "Zebra",
    ]);
  });

  test("sorts accented names with their base letter", () => {
    expect(["Zeta", "Ärger", "Bravo"].sort(compareNames)).toEqual([
      "Ärger",
      "Bravo",
      "Zeta",
    ]);
  });

  test("compares numbers by value", () => {
    expect(["repo-10", "repo-2", "repo-1"].sort(compareNames)).toEqual([
      "repo-1",
      "repo-2",
      "repo-10",
    ]);
  });
});
