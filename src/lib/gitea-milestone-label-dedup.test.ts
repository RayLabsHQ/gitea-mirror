/**
 * Regression test for duplicate milestone & label creation on every sync.
 *
 * Observed in production (May 2026): a Gitea instance accumulated
 * 11,847 duplicate closed milestones across 4 mirrored repos after only
 * a handful of scheduled syncs. Two compounding bugs in
 * `mirrorGitRepoMilestonesToGitea`:
 *
 *   (1) The existing-milestones GET to Gitea did NOT pass `state=all`.
 *       Gitea's /milestones endpoint defaults to `state=open`, so the
 *       `existingMilestones` Set never contained any closed milestone
 *       title. Every closed GitHub milestone was misclassified as
 *       missing and re-POSTed on every sync.
 *
 *   (2) The existing-milestones GET was a single unpaginated call.
 *       Gitea caps response size at `[api].MAX_RESPONSE_ITEMS`
 *       (default 50), so any repo with more milestones than that
 *       silently truncates even when (1) is fixed.
 *
 * `mirrorGitRepoLabelsToGitea` has the same pagination bug (2). It
 * doesn't have bug (1) because /labels has no state filter, and it
 * hadn't yet shown duplicates in production only because no mirrored
 * repo had crossed 50 distinct labels — but it would the moment one
 * did.
 *
 * These tests assert on the *structure* of the source rather than
 * invoking the functions, because behavioral tests for the metadata
 * pipeline require heavy module mocks that pollute other test files
 * (bun's mock.module is process-wide). Same convention as
 * `gitea-issue-dedup-on-retry.test.ts` and
 * `gitea-mirror-failure-recovery.test.ts`.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "gitea.ts"), "utf8");

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
  while (i < source.length && source[i] !== "(") i++;
  if (source[i] !== "(") {
    throw new Error(`No '(' after ${declarationStart}`);
  }
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
  while (i < source.length && source[i] !== "{") i++;
  if (source[i] !== "{") {
    throw new Error(`No body '{' for ${declarationStart}`);
  }
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

describe("milestone dedup on sync", () => {
  const body = extractFunctionBody(
    SOURCE,
    /export async function mirrorGitRepoMilestonesToGitea\b/
  );

  test("body contains the per-milestone create branch we expect to guard", () => {
    // Sanity check: anchor the rest of this suite to the right path.
    expect(
      body.includes("existingMilestones"),
      "expected the existingMilestones set/map used for dedup"
    ).toBe(true);
    expect(
      body.match(
        /await httpPost\(\s*`\$\{config\.giteaConfig\.url\}\/api\/v1\/repos\/\$\{giteaOwner\}\/\$\{repoName\}\/milestones`/
      ),
      "expected the create-milestone httpPost call"
    ).toBeTruthy();
  });

  test("existing-milestones GET must include state=all", () => {
    // Without state=all, Gitea returns only open milestones, so every
    // closed GitHub milestone is misclassified as missing and re-POSTed
    // on every sync. This was the root cause of the production blowup.
    const getMatch = body.match(
      /httpGet\(\s*`\$\{config\.giteaConfig\.url\}\/api\/v1\/repos\/\$\{giteaOwner\}\/\$\{repoName\}\/milestones\?[^`]*`/
    );
    expect(
      getMatch,
      "expected a milestones httpGet call with a query string"
    ).toBeTruthy();
    expect(
      /state=all/.test(getMatch![0]),
      "the existing-milestones GET must pass state=all (Gitea defaults to state=open)"
    ).toBe(true);
  });

  test("existing-milestones GET must paginate via Link header", () => {
    // Even with state=all, a single unpaginated call only ever sees
    // the first 50 milestones (Gitea's MAX_RESPONSE_ITEMS cap).
    expect(
      /milestonesPage\s*\+=\s*1/.test(body),
      "expected a page-increment loop for existing milestones"
    ).toBe(true);
    expect(
      /\.headers\.get\(\s*["']link["']\s*\)/.test(body) &&
        /rel="next"/.test(body),
      "the existing-milestones pagination loop must use the Link header (rel=\"next\") to decide whether to fetch the next page"
    ).toBe(true);
  });

  test("newly-created milestone must be cached into existingMilestones", () => {
    // Defensive: if `milestones` ever contains a same-named entry
    // twice (unlikely but cheap to guard), we shouldn't POST it twice.
    expect(
      /existingMilestones\.add\(\s*milestone\.title\s*\)/.test(body),
      "after a successful create, the new milestone title must be added to existingMilestones"
    ).toBe(true);
  });
});

describe("label dedup on sync", () => {
  const body = extractFunctionBody(
    SOURCE,
    /export async function mirrorGitRepoLabelsToGitea\b/
  );

  test("body contains the per-label create branch we expect to guard", () => {
    expect(
      body.includes("existingLabels"),
      "expected the existingLabels set used for dedup"
    ).toBe(true);
    expect(
      body.match(
        /await httpPost\(\s*`\$\{config\.giteaConfig\.url\}\/api\/v1\/repos\/\$\{giteaOwner\}\/\$\{repoName\}\/labels`/
      ),
      "expected the create-label httpPost call"
    ).toBeTruthy();
  });

  test("existing-labels GET must paginate via Link header", () => {
    // Same Gitea MAX_RESPONSE_ITEMS=50 cap as milestones / issues.
    // No state filter applies to labels, so pagination is the only
    // correctness concern here.
    expect(
      /labelsPage\s*\+=\s*1/.test(body),
      "expected a page-increment loop for existing labels"
    ).toBe(true);
    expect(
      /\.headers\.get\(\s*["']link["']\s*\)/.test(body) &&
        /rel="next"/.test(body),
      "the existing-labels pagination loop must use the Link header (rel=\"next\") to decide whether to fetch the next page"
    ).toBe(true);
  });

  test("newly-created label must be cached into existingLabels", () => {
    expect(
      /existingLabels\.add\(\s*label\.name\s*\)/.test(body),
      "after a successful create, the new label name must be added to existingLabels"
    ).toBe(true);
  });
});
