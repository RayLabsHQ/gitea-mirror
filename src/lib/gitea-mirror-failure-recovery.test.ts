/**
 * Regression test for issue #268.
 *
 * `let migrateSucceeded = false;` was declared *inside* the try block
 * of mirrorGithubRepoToGitea and mirrorGitHubRepoToGiteaOrg, but the
 * catch block referenced it. `let` is block-scoped to the try, so any
 * error inside try made the catch crash with `ReferenceError:
 * migrateSucceeded is not defined` before reaching the DB update that
 * marks the repo "failed". Result: repos stuck in "mirroring" forever
 * with no entry in the activity log (see issue logs).
 *
 * This test asserts the declaration is hoisted above the try block in
 * both functions. It deliberately reads the source rather than calling
 * the functions, because behavioral tests for these functions require
 * heavy module mocks that pollute other test files (bun's mock.module
 * is process-wide and persists across files).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dir, "gitea.ts"),
  "utf8"
);

/**
 * Locate the body of a function declaration by name. Walks from the
 * declaration, balances parens to skip the parameter list (which can
 * contain destructured object literals with their own braces), then
 * finds the body's opening brace and its matching close.
 */
function extractFunctionBody(source: string, declarationStart: RegExp): string {
  const match = source.match(declarationStart);
  if (!match) {
    throw new Error(`Could not locate declaration ${declarationStart}`);
  }
  let i = match.index! + match[0].length;
  // Skip whitespace until the opening paren of the parameter list.
  while (i < source.length && source[i] !== "(") i++;
  if (source[i] !== "(") {
    throw new Error(`No '(' after ${declarationStart}`);
  }
  // Balance parens to find the end of the parameter list. Braces inside
  // the parameter list (e.g. destructured `{ foo, bar }`) are allowed
  // and ignored.
  let parenDepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "(") parenDepth++;
    else if (source[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        i++;
        break;
      }
    }
  }
  // Skip return-type annotation, => arrow, whitespace, until the body's `{`.
  while (i < source.length && source[i] !== "{") i++;
  if (source[i] !== "{") {
    throw new Error(`No body '{' for ${declarationStart}`);
  }
  // Balance braces for the body.
  let braceDepth = 0;
  const startIdx = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") braceDepth++;
    else if (source[i] === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        return source.slice(startIdx, i + 1);
      }
    }
  }
  throw new Error(`Unterminated body for ${declarationStart}`);
}

/**
 * Confirm that within a function body, the first `let migrateSucceeded`
 * declaration occurs BEFORE the function's outermost `try {`.
 *
 * If the declaration is inside the try block, the catch block can't see
 * it (ReferenceError in production = repo stuck mirroring).
 */
function assertMigrateSucceededDeclaredBeforeTry(body: string, label: string) {
  const declIdx = body.indexOf("let migrateSucceeded");
  expect(declIdx, `${label}: 'let migrateSucceeded' should exist`).toBeGreaterThanOrEqual(0);

  // The function's outermost try is the first standalone `try {` in
  // the body — assignments and inner try/catches don't share its name.
  const tryIdx = body.search(/\btry\s*\{/);
  expect(tryIdx, `${label}: outermost 'try {' should exist`).toBeGreaterThanOrEqual(0);

  expect(
    declIdx,
    `${label}: 'let migrateSucceeded' must be declared BEFORE the try block ` +
      `so the catch block can read it. If declared inside try, it's block-scoped ` +
      `and the catch will throw ReferenceError, leaving repos stuck in 'mirroring'. ` +
      `See issue #268.`
  ).toBeLessThan(tryIdx);

  // And it should still be assigned to true after the migrate call —
  // otherwise the catch can't tell whether to clear mirroredLocation.
  expect(
    body.includes("migrateSucceeded = true"),
    `${label}: 'migrateSucceeded = true' assignment should exist after the migrate call`
  ).toBe(true);

  // And the catch must read it.
  expect(
    body.includes("if (!migrateSucceeded)"),
    `${label}: catch block should read 'migrateSucceeded' to decide whether to clear mirroredLocation`
  ).toBe(true);
}

describe("issue #268 — migrateSucceeded scoping regression", () => {
  test("mirrorGithubRepoToGitea declares migrateSucceeded outside try", () => {
    const body = extractFunctionBody(
      SOURCE,
      /export const mirrorGithubRepoToGitea = async\b/
    );
    assertMigrateSucceededDeclaredBeforeTry(body, "mirrorGithubRepoToGitea");
  });

  test("mirrorGitHubRepoToGiteaOrg declares migrateSucceeded outside try", () => {
    const body = extractFunctionBody(
      SOURCE,
      /export async function mirrorGitHubRepoToGiteaOrg\b/
    );
    assertMigrateSucceededDeclaredBeforeTry(body, "mirrorGitHubRepoToGiteaOrg");
  });
});
