/**
 * Regression test for duplicate-issue creation on retry-after-deadlock.
 *
 * `mirrorGitRepoIssuesToGitea` pre-fetches all existing Gitea issues
 * into `giteaIssueByGitHubNumber` ONCE at function entry, then iterates
 * per-issue via `processWithRetry`. Each iteration uses the cached map
 * to decide CREATE vs PATCH.
 *
 * The bug: when Gitea's CreateIssue handler commits the issue insert
 * in one transaction and then deadlocks on the addLabel / repository
 * counter update in a second transaction, the issue row is committed
 * and visible — but the in-memory map is never refreshed between
 * retries. So `processWithRetry` would call the callback again,
 * `existingIssue` is still `undefined` from the stale map, and a fresh
 * `httpPost` creates a duplicate.
 *
 * Reproduces deterministically on MySQL (1213/40001) and PostgreSQL
 * (40P01). SQLite escapes because writes serialize globally.
 *
 * This test asserts on the *structure* of the source rather than
 * invoking the function, because behavioral tests for the issue-mirror
 * pipeline require heavy module mocks that pollute other test files
 * (bun's mock.module is process-wide). See
 * `gitea-mirror-failure-recovery.test.ts` for the same convention.
 *
 * The two structural guarantees this test enforces:
 *   (1) Before the create-issue httpPost call, the code performs a
 *       defensive recheck via httpGet that queries Gitea by
 *       `[GH-ISSUE #N]` title marker — handles "previous attempt
 *       committed the issue then threw" scenarios.
 *   (2) After a successful httpPost create, the new issue is written
 *       back into `giteaIssueByGitHubNumber` — handles "this attempt
 *       created the issue, but a later step in the same callback
 *       (e.g. comment sync) throws and triggers another retry"
 *       scenarios.
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
 *
 * Same helper as in `gitea-mirror-failure-recovery.test.ts`; kept
 * local to keep this test file self-contained.
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

describe("issue dedup on retry-after-deadlock", () => {
  const body = extractFunctionBody(
    SOURCE,
    /export const mirrorGitRepoIssuesToGitea = async\b/
  );

  test("body contains the per-issue create branch we expect to guard", () => {
    // Sanity: make sure the test is looking at the right code path.
    // If these strings disappear due to a refactor, this test should
    // fail loudly so a human reviews whether the dedup guarantees
    // still hold in the new shape.
    expect(
      body.includes(
        "giteaIssueByGitHubNumber.get(issue.number)"
      ),
      "expected the per-issue lookup against giteaIssueByGitHubNumber"
    ).toBe(true);
    expect(
      body.match(/await httpPost\(\s*`\$\{config\.giteaConfig!\.url\}\/api\/v1\/repos\/\$\{giteaOwner\}\/\$\{repoName\}\/issues`/),
      "expected the create-issue httpPost call"
    ).toBeTruthy();
  });

  test("defensive recheck via httpGet runs BEFORE the create httpPost", () => {
    // The recheck must query Gitea by [GH-ISSUE #N] marker to catch
    // the partial-commit case. Without it, a deadlock-after-insert
    // returns 5xx, processWithRetry re-runs the callback, and the
    // create call produces a duplicate row.
    const recheckIdx = body.search(
      /await httpGet\([^)]*\[GH-ISSUE #\$\{issue\.number\}\]/
    );
    expect(
      recheckIdx,
      "defensive recheck via httpGet using [GH-ISSUE #N] marker must exist"
    ).toBeGreaterThanOrEqual(0);

    // The recheck must come before the create httpPost in source order.
    // The first httpPost on the .../issues endpoint inside this
    // function body is the create call; we anchor against it.
    const createIdx = body.search(
      /await httpPost\(\s*`\$\{config\.giteaConfig!\.url\}\/api\/v1\/repos\/\$\{giteaOwner\}\/\$\{repoName\}\/issues`/
    );
    expect(createIdx, "create httpPost call must exist").toBeGreaterThanOrEqual(0);

    expect(
      recheckIdx,
      "the recheck must run BEFORE the create call so it can short-circuit on partial-commit duplicates"
    ).toBeLessThan(createIdx);
  });

  test("recheck hit short-circuits via PATCH and updates the cache", () => {
    // When the recheck finds a hit (i.e. a previous failed attempt
    // already created this issue), the code should:
    //   - cache the hit into giteaIssueByGitHubNumber so subsequent
    //     retries within this run also find it
    //   - go down the PATCH path (httpPatch) instead of httpPost
    //   - log a recognisable line so operators can spot recovery
    expect(
      body.includes(
        "giteaIssueByGitHubNumber.set(issue.number, recheckHit)"
      ) ||
        body.match(/giteaIssueByGitHubNumber\.set\(\s*issue\.number\s*,\s*recheckHit/),
      "recheck hit must be written back into giteaIssueByGitHubNumber"
    ).toBeTruthy();

    expect(
      body.match(/Recovered orphan from prior failed attempt/i),
      "a log line should make the recovery path visible in operator logs"
    ).toBeTruthy();
  });

  test("pre-fetch issues pagination uses Link header (not short-page heuristic)", () => {
    // The previous `if (pageIssues.length < issuesPerPage) break;`
    // heuristic was wrong in both directions:
    //   - Gitea caps response size at `[api].MAX_RESPONSE_ITEMS`
    //     (default 50), typically lower than `issuesPerPage` (100),
    //     so the very first page already looks "short" and
    //     pagination terminated after 50 items. Every issue past
    //     that was misclassified as new and duplicated on every sync.
    //   - Naive removal of that break, relying only on "break on
    //     empty page", can loop forever because some Gitea endpoints
    //     return the same data on every page when asked for a page
    //     past the actual end (instead of returning []).
    //
    // The correct fix is to use the Link header (RFC 5988): if
    // `rel="next"` is absent, we're done.
    //
    // This test asserts:
    //   - the broken short-page check is gone
    //   - the existing-issues loop checks the Link header for next
    const issuesPaginationRegion = body.substring(
      body.indexOf("existingGiteaIssues.push"),
      body.indexOf("issuesPage += 1") + 30
    );
    expect(
      issuesPaginationRegion,
      "issues pagination region should be present"
    ).not.toBe("");
    expect(
      /\bpageIssues\.length\s*<\s*issuesPerPage\b/.test(issuesPaginationRegion),
      "the short-page break (pageIssues.length < issuesPerPage) must be removed"
    ).toBe(false);
    expect(
      /existingIssuesRes\.headers\.get\(\s*["']link["']\s*\)/.test(
        issuesPaginationRegion
      ) && /rel="next"/.test(issuesPaginationRegion),
      "the issues pagination loop must use the Link header (rel=\"next\") " +
        "to decide whether to fetch the next page"
    ).toBe(true);
  });

  test("per-issue comments pagination also uses Link header (not short-page heuristic)", () => {
    // Same correctness concerns as issues pagination above. The per-
    // issue comments endpoint is subject to the same Gitea page-size
    // cap, and naive empty-page detection has the same risk.
    expect(
      /\bpageComments\.length\s*<\s*commentsPerPage\b/.test(body),
      "the short-page break (pageComments.length < commentsPerPage) must be removed"
    ).toBe(false);
    // Look only at the comments-fetch region (not the whole file) so
    // a future caller using a different response variable name in
    // another place won't false-positive this assertion.
    const commentsRegion = body.substring(
      body.indexOf("existingComments.push"),
      body.indexOf("commentsPage += 1") + 30
    );
    expect(
      commentsRegion,
      "comments pagination region should be present"
    ).not.toBe("");
    expect(
      /existingCommentsRes\.headers\.get\(\s*["']link["']\s*\)/.test(
        commentsRegion
      ) && /rel="next"/.test(commentsRegion),
      "the comments pagination loop must use the Link header (rel=\"next\") " +
        "to decide whether to fetch the next page"
    ).toBe(true);
  });

  describe("PR mirror has the same guarantees", () => {
    // mirrorGitRepoPullRequestsToGitea has parallel structure:
    // - pre-fetches existing Gitea "issues that are mirrored PRs",
    //   keyed by `[PR #N]` marker in title
    // - per-PR callback decides PATCH vs CREATE
    // - same Gitea-side pagination cap and deadlock-after-commit
    //   risks apply
    // The fix mirrors gitea-issues here.
    const prBody = extractFunctionBody(
      SOURCE,
      /export async function mirrorGitRepoPullRequestsToGitea\b/
    );

    test("PR pre-fetch pagination uses Link header", () => {
      expect(
        /\bpageIssues\.length\s*<\s*prIssuesPerPage\b/.test(prBody),
        "the short-page break (pageIssues.length < prIssuesPerPage) must be removed"
      ).toBe(false);
      // The PR pre-fetch reuses the existingIssuesRes variable name
      expect(
        /existingIssuesRes\.headers\.get\(\s*["']link["']\s*\)/.test(prBody) &&
          /rel="next"/.test(prBody),
        "the PR pre-fetch loop must use the Link header (rel=\"next\")"
      ).toBe(true);
    });

    test("PR create path defensively rechecks via [PR #N] before httpPost", () => {
      // Both the enriched and basic-fallback create paths must have
      // a recheck so partial-commit retries don't duplicate the PR.
      const rechecks =
        prBody.match(/Recovered orphan from prior failed attempt for PR/g) ||
        [];
      expect(
        rechecks.length,
        "expected at least two 'Recovered orphan' log lines " +
          "(one for the enriched create path, one for the basic-fallback path)"
      ).toBeGreaterThanOrEqual(2);
    });
  });

  test("successful create caches the new issue into the dedup map", () => {
    // Without this, a retry triggered by a *later* step in the same
    // per-issue callback (e.g. comment sync throwing) would re-enter
    // the create path on the next attempt — same root duplication
    // pattern, different trigger.
    expect(
      body.match(
        /giteaIssueByGitHubNumber\.set\(\s*issue\.number\s*,\s*createdIssue\.data\s*\)/
      ),
      "after a successful create, the new issue must be stored in giteaIssueByGitHubNumber"
    ).toBeTruthy();
  });
});
